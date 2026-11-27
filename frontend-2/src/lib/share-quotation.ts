// Sending a quotation link to a client's WhatsApp number or e-mail address. Both open the person's own WhatsApp or mail program with the message ready: nothing is sent
// from this site, and the person presses send. Safe to import from both server and browser code.

/** WhatsApp wants the number with its country code and digits only. A 10-digit number is taken as an Indian number. */
export function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

/** A WhatsApp link to that number with the message ready. A number that is too short to be real opens WhatsApp with no one chosen, to pick a contact. */
export function whatsappLink(phone: string, text: string): string {
  const n = whatsappNumber(phone);
  return `https://wa.me/${n.length >= 8 ? n : ""}?text=${encodeURIComponent(text)}`;
}

/** A mail link to that address (or none, to choose one) with the subject and message ready. */
export function mailtoLink(email: string, subject: string, body: string): string {
  return `mailto:${email.trim()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The message that goes with a quotation link. */
export function quotationMessage(input: { name: string; number: string; title: string; business: string; link: string; validUntil: string }): string {
  return [
    `Hello ${input.name},`,
    `Your quotation ${input.number} for "${input.title}" from ${input.business} is ready.`,
    `View it here: ${input.link}`,
    `This link is valid until ${new Date(input.validUntil).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.`,
  ].join("\n\n");
}
