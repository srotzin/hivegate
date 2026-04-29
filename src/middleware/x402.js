import { applyLoyaltyDiscount, buildLoyaltyChallenge } from './loyalty.js';

const PRICING = {
  'register-guest': { amount: 4.99, description: 'Guest DID registration' },
  'renew-guest': { amount: 2.99, description: 'Guest DID renewal' },
  'translate-intent': { amount: 0.02, description: 'Intent translation' },
  'bridge-trust': { amount: 0.10, description: 'Trust bridge mapping' },
  'execute': { type: 'percentage', rate: 0.005, min: 0.01, description: 'Cross-ecosystem execution (0.5% bridge fee)' },
  'escrow-create': { type: 'percentage', rate: 0.01, min: 0.25, description: 'Escrow creation (1% fee)' }
};

export function requirePayment(feeKey) {
  return async (req, res, next) => {
    const pricing = PRICING[feeKey];
    if (!pricing) return next();

    // Internal key bypass — Hive services skip payment
    const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
    const expectedKey = process.env.HIVE_INTERNAL_KEY || process.env.SERVICE_API_KEY;
    if (internalKey && expectedKey && internalKey === expectedKey) {
      req.paymentVerified = true;
      req.paymentAmount = 0;
      req.paymentDescription = `${pricing.description} (internal bypass)`;
      return next();
    }

    const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];

    let requiredAmount;
    if (pricing.type === 'percentage') {
      const txValue = parseFloat(req.body?.amount_usdc || req.body?.max_fee_usdc || 0);
      requiredAmount = Math.max(txValue * pricing.rate, pricing.min);
    } else {
      requiredAmount = pricing.amount;
    }

    // x402 payment required — Rail 3 loyalty discount applied
    if (!paymentHeader) {
      // Convert USD price to atomic USDC (6-decimal)
      const basePriceAtomic = Math.round(requiredAmount * 1_000_000);
      const loyaltyResult = await applyLoyaltyDiscount(req, res, basePriceAtomic);
      const adjustedUsd = loyaltyResult.adjustedPrice / 1_000_000;

      return res.status(402).json({
        error: 'payment_required',
        x402: buildLoyaltyChallenge({
          adjustedPrice:      loyaltyResult.adjustedPrice,
          discountAppliedBps: loyaltyResult.discountAppliedBps,
          resource:           req.originalUrl,
          description:        pricing.description,
        }),
        amount_usdc:     adjustedUsd,
        payment_methods: ['x402-usdc'],
        headers_required: ['X-Payment'],
        note: loyaltyResult.discountAppliedBps > 0
          ? `Receipt-gravity discount applied: ${loyaltyResult.discountAppliedBps / 100}% off (Rail 3). Include X-Payment header with payment proof to proceed.`
          : 'Include X-Payment header with payment proof to proceed. Send X-Hive-Prior-Receipts for loyalty discount (5% per receipt, max 25%).'
      });
    }

    // In production, verify payment proof cryptographically
    req.paymentVerified = true;
    req.paymentAmount = requiredAmount;
    req.paymentDescription = pricing.description;
    next();
  };
}

export { PRICING };
