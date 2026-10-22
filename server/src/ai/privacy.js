// IJF AI never sends a phone number or an email address to OpenAI. Every one, in what a person types or in
// anything the AI looks up, is replaced by a stand-in such as [phone 3] or [email 1] before it leaves this
// server; the real value stays here (the chat's `secrets`) and is put back only in what the person sees,
// and in a change they confirm. The same value always gets the same stand-in within a chat.

// 10–15 digits, with spaces, dots, dashes or brackets between them (not a date: 8 digits; not inside a
// word or an id: letters on either side).
const PHONE = /(?<![\w@])\+?\d(?:[\s().-]*\d){9,14}(?![\w@])/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
export const TOKEN = /\[(phone|email) \d+\]/g;

// The stand-in for a value (the same one if it was seen before in this chat).
function tokenFor(kind, value, secrets) {
  const key = kind === 'email' ? value.toLowerCase() : value.replace(/\D/g, '').slice(-10);
  for (const [token, stored] of Object.entries(secrets)) {
    if (token.startsWith(`[${kind} `) && (kind === 'email' ? stored.toLowerCase() === key : stored.replace(/\D/g, '').slice(-10) === key)) return token;
  }
  const n = Object.keys(secrets).filter((t) => t.startsWith(`[${kind} `)).length + 1;
  const token = `[${kind} ${n}]`;
  secrets[token] = value.trim();
  return token;
}

// A text with its phone numbers and emails replaced by stand-ins (secrets gets the new ones).
export function hideContacts(text, secrets) {
  return String(text)
    .replace(EMAIL, (email) => tokenFor('email', email, secrets))
    .replace(PHONE, (phone) => tokenFor('phone', phone, secrets));
}

// The same for anything (a tool's result): every string inside it, at any depth.
export function protect(value, secrets) {
  if (typeof value === 'string') return hideContacts(value, secrets);
  if (Array.isArray(value)) return value.map((v) => protect(v, secrets));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, protect(v, secrets)]));
  }
  return value;
}

// Stand-ins back to the real values (what the person sees; a change they confirm).
export function reveal(value, secrets) {
  if (typeof value === 'string') return value.replace(TOKEN, (token) => secrets[token] ?? token);
  if (Array.isArray(value)) return value.map((v) => reveal(v, secrets));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reveal(v, secrets)]));
  }
  return value;
}

// For streamed text: stand-ins put back as the words arrive, holding back a "[phone 1" that is still
// arriving until its "]" does. push(delta) returns what can be shown now; flush() the rest.
export function createRevealer(secrets) {
  let held = '';
  return {
    push(delta) {
      held += delta;
      const open = held.lastIndexOf('[');
      const cut = open >= 0 && !held.includes(']', open) && held.length - open < 16 ? open : held.length;
      const ready = held.slice(0, cut);
      held = held.slice(cut);
      return reveal(ready, secrets);
    },
    flush() {
      const rest = reveal(held, secrets);
      held = '';
      return rest;
    },
  };
}

// True when a text still has a phone number or email in it (tests and a last check before sending).
export const hasContacts = (text) => new RegExp(PHONE.source).test(text) || new RegExp(EMAIL.source, 'i').test(text);
