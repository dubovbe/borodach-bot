import { expect, it } from 'vitest';
import { normalizePhone, invitationToken } from '../../src/identity/service';

it('normalizes valid international and default RU numbers, including Telegram digits', () => {
  expect(normalizePhone('8 (912) 345-67-89')).toBe('+79123456789');
  expect(normalizePhone('+44 20 7946 0018')).toBe('+442079460018');
  expect(normalizePhone('442079460018', true)).toBe('+442079460018');
});
it.each(['', '123', '+7 912 345 67 89 ext. 12', 'call +79123456789', '+999123456789', '7'.repeat(100)])('rejects unsafe/invalid phone %s', value => {
  expect(() => normalizePhone(value)).toThrow();
});
it('invitation tokens are stable opaque base64url with separate mandatory secret', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const token = await invitationToken(id, 'test-only-invitation-secret-000000000000000000');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await invitationToken(id, 'test-only-invitation-secret-000000000000000000')).toBe(token);
  await expect(invitationToken(id, '')).rejects.toThrow();
});
