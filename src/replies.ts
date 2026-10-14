export type ReplyClassification = 'positive' | 'negative' | 'opt-out' | 'out-of-office' | 'question' | 'unknown';

const optOut = /\b(unsubscribe|remove me|stop emailing|do not (?:email|contact)|don't (?:email|contact)|not interested)\b/i;
const outOfOffice = /\b(out of (?:the )?office|automatic reply|away from (?:the )?office|on (?:vacation|leave))\b/i;
const positive = /\b(interested|sounds good|tell me more|send (?:it|the example)|book|schedule|let'?s talk|worth a look|yes)\b/i;
const negative = /\b(no thanks|pass|not a fit|wrong person|already have|not now)\b/i;

export function classifyReply(body: string): ReplyClassification {
  if (optOut.test(body)) return 'opt-out';
  if (outOfOffice.test(body)) return 'out-of-office';
  if (positive.test(body)) return 'positive';
  if (negative.test(body)) return 'negative';
  if (body.includes('?')) return 'question';
  return 'unknown';
}
