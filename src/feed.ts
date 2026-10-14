import type { CatalogProduct } from './contracts.js';
import { catalogProductSchema, findingSchema, hashValue } from './contracts.js';

export interface FeedLintResult {
  inputHash: string;
  score: number;
  products: CatalogProduct[];
  findings: Array<{
    code: string;
    severity: 'info' | 'warning' | 'critical';
    productId: string | null;
    message: string;
    correction: string;
  }>;
}

export function lintCatalog(rawProducts: unknown[], marginFloorBps: number | null): FeedLintResult {
  const products = rawProducts.map((row) => catalogProductSchema.parse(row));
  const findings: FeedLintResult['findings'] = [];

  for (const product of products) {
    if (product.description.trim().length < 80) {
      findings.push({
        code: 'description-thin',
        severity: 'warning',
        productId: product.externalId,
        message: `${product.title} has too little descriptive context for reliable agent matching.`,
        correction: 'Add material, use case, sizing/fit, differentiators, and care or compatibility details.',
      });
    }
    if (!product.brand.trim()) {
      findings.push({
        code: 'brand-missing',
        severity: 'warning',
        productId: product.externalId,
        message: `${product.title} has no brand value.`,
        correction: 'Provide the canonical brand or manufacturer name.',
      });
    }
    if (!product.category.trim()) {
      findings.push({
        code: 'category-missing',
        severity: 'critical',
        productId: product.externalId,
        message: `${product.title} has no category, weakening discovery and comparisons.`,
        correction: 'Add the most specific supported product category and relevant attributes.',
      });
    }
    if (!product.imageUrl.trim()) {
      findings.push({
        code: 'image-missing',
        severity: 'warning',
        productId: product.externalId,
        message: `${product.title} has no primary image URL.`,
        correction: 'Add a stable HTTPS primary image with descriptive alt text.',
      });
    }
    if (!product.sku.trim()) {
      findings.push({
        code: 'sku-missing',
        severity: 'warning',
        productId: product.externalId,
        message: `${product.title} has no SKU for deterministic variant matching.`,
        correction: 'Assign a stable unique SKU to every purchasable variant.',
      });
    }
    if (product.inventoryQty <= 0) {
      findings.push({
        code: 'inventory-zero',
        severity: 'critical',
        productId: product.externalId,
        message: `${product.title} is unavailable to an automated shopper.`,
        correction: 'Confirm stock state or expose a preorder/back-in-stock policy explicitly.',
      });
    }
    if (product.costCents === null) {
      findings.push({
        code: 'cost-missing',
        severity: 'info',
        productId: product.externalId,
        message: `${product.title} has no cost data, so margin-safe offers are disabled.`,
        correction: 'Provide cost in a private fulfillment input before enabling price recommendations.',
      });
    } else if (marginFloorBps !== null && product.priceCents > 0) {
      const marginBps = Math.floor(((product.priceCents - product.costCents) / product.priceCents) * 10_000);
      if (marginBps < marginFloorBps) {
        findings.push({
          code: 'margin-below-floor',
          severity: 'critical',
          productId: product.externalId,
          message: `${product.title} is already below the supplied margin floor.`,
          correction: 'Disable discount recommendations and review price, cost, or floor policy.',
        });
      }
    }
  }

  const counts = findings.reduce(
    (acc, finding) => ({ ...acc, [finding.severity]: acc[finding.severity] + 1 }),
    { info: 0, warning: 0, critical: 0 },
  );
  const score = Math.max(0, 100 - counts.critical * 12 - counts.warning * 5 - counts.info * 1);
  return {
    inputHash: hashValue(products),
    score,
    products,
    findings: findings.map((finding) => findingSchema.parse(finding)),
  };
}

