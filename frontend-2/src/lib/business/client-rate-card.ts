// What a client may see of the studio's rate card (pure: no I/O).
//
// The wizard prices the project in the browser while the client fills it in, so the client's copy of the rate card has to carry the prices (the hours per page and
// feature, the hourly price, the technology factors): they are shown on the quotation line by line anyway. It must NOT carry what is the studio's own business:
// the bank and payment details (the quotation page shows those only to the client of an issued quotation), the studio's contact details, and above all the most
// discount the studio is willing to give, which is negotiating room. The server prices every quotation again from the real rate card; this copy is only a preview.
import type { RateCard } from "./types";

export function clientRateCard(card: RateCard): RateCard {
  return {
    ...card,
    business: { name: card.business.name, gstin: "", state: card.business.state, address: "", email: "", phone: "" },
    maxDiscountPercent: 0,
  };
}
