const PRICING = {
  'register-guest': { amount: 4.99, description: 'Guest DID registration' },
  'renew-guest': { amount: 2.99, description: 'Guest DID renewal' },
  'translate-intent': { amount: 0.02, description: 'Intent translation' },
  'bridge-trust': { amount: 0.10, description: 'Trust bridge mapping' },
  'execute': { type: 'percentage', rate: 0.005, min: 0.01, description: 'Cross-ecosystem execution (0.5% bridge fee)' },
  'escrow-create': { type: 'percentage', rate: 0.01, min: 0.25, description: 'Escrow creation (1% fee)' }
};

export function requirePayment(feeKey) {
  return (req, res, next) => {
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

    // x402 payment required
    if (!paymentHeader) {
      return res.status(402).json({
        error: 'payment_required',
        x402: {
          version: '1.0',
          amount_usdc: requiredAmount,
          description: pricing.description,
          payment_methods: ['x402-usdc', 'x402-lightning'],
          headers_required: ['X-Payment'],
          note: 'Include X-Payment header with payment proof to proceed'
        }
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
