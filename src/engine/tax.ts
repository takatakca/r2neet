import { applyRate, sum, type Cents } from '../domain/money.js';
import {
  QuoteLineType,
  TaxCompounding,
  type QuoteLine,
  type TaxLine,
  type TaxRule,
} from '../domain/types.js';

/**
 * Québec tax engine.
 *
 * GST (5%) and QST (9.975%) are each calculated independently from the
 * PRE-TAX taxable subtotal. QST does NOT compound on GST — that stopped being
 * correct in Québec in 2013 and would overcharge every customer.
 *
 * Each tax line is rounded half-up to the cent independently.
 *
 *   taxable subtotal $135.00
 *     GST = 135.00 × 5%      = $6.75
 *     QST = 135.00 × 9.975%  = $13.46625 -> $13.47
 *     tax total              = $20.22
 *     grand total            = $155.22
 *
 * displayOrder exists for presentation only and must never affect arithmetic.
 */

function ruleAppliesToLine(rule: TaxRule, line: QuoteLine): boolean {
  switch (line.type) {
    case QuoteLineType.SERVICE:
    case QuoteLineType.FREQUENCY_DISCOUNT:
    case QuoteLineType.PROMOTION_DISCOUNT:
      return rule.appliesToServices;
    case QuoteLineType.PRODUCTS:
      return rule.appliesToProducts;
    case QuoteLineType.TRANSPORT:
      return rule.appliesToTransportation;
    case QuoteLineType.DISTANCE:
      return rule.appliesToMileage;
    case QuoteLineType.ADD_ON:
      return rule.appliesToAddOns;
    case QuoteLineType.TAX:
      return false;
  }
}

export interface TaxResult {
  taxLines: TaxLine[];
  taxTotalCents: Cents;
  taxableSubtotalCents: Cents;
  nonTaxableSubtotalCents: Cents;
}

export function calculateTax(lines: QuoteLine[], rules: TaxRule[]): TaxResult {
  const active = rules.filter((r) => r.active);

  const compounded = active.filter((r) => r.compounding === TaxCompounding.COMPOUNDED);
  if (compounded.length > 0) {
    throw new Error(
      `compounded tax rules are not supported in the Québec configuration: ${compounded
        .map((r) => r.code)
        .join(', ')}`,
    );
  }

  const taxLines: TaxLine[] = active
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((rule) => {
      // Each rule sees only the lines it applies to, at their PRE-TAX value.
      // Discount lines are negative and therefore reduce the base correctly.
      const base = sum(
        ...lines.filter((l) => l.taxable && ruleAppliesToLine(rule, l)).map((l) => l.subtotalCents),
      );
      return {
        code: rule.code,
        name: rule.name,
        rate: rule.rate,
        taxableBaseCents: base,
        amountCents: applyRate(Math.max(base, 0), rule.rate),
      };
    });

  const taxableSubtotalCents = sum(
    ...lines.filter((l) => l.taxable && l.type !== QuoteLineType.TAX).map((l) => l.subtotalCents),
  );
  const nonTaxableSubtotalCents = sum(
    ...lines.filter((l) => !l.taxable && l.type !== QuoteLineType.TAX).map((l) => l.subtotalCents),
  );

  return {
    taxLines,
    taxTotalCents: sum(...taxLines.map((t) => t.amountCents)),
    taxableSubtotalCents,
    nonTaxableSubtotalCents,
  };
}
