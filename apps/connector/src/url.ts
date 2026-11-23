/** A server address the connector may use: HTTPS, or HTTP to this computer for development. */
export const checkServerUrl = (raw: string): { ok: true; url: string } | { ok: false; reason: string } => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That is not a web address.' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { ok: false, reason: 'Use the server’s https:// address; plain HTTP is accepted only for this computer.' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'Leave credentials out of the address; the token is separate.' };
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/u, '')}` };
};
