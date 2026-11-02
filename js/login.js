// Look up the numeric EcoFlow user ID (needed for BLE auth) via the same login call the app uses.
// The password is sent only to EcoFlow over HTTPS, never stored or logged.
// Flow credit: rabits/ha-ef-ble (Apache-2.0). See NOTICE.

export class LoginError extends Error {}

export async function fetchUserId(email, password, { host = 'api.ecoflow.com', fetchImpl = globalThis.fetch } = {}) {
  const pwBytes = new TextEncoder().encode(password);
  const body = {
    scene: 'IOT_APP', appVersion: '1.0.0', userType: 'ECOFLOW', email,
    password: btoa(String.fromCharCode(...pwBytes)), // base64 encoding, not hashing (that's what the API expects)
    oauth: { bundleId: 'com.ef.EcoFlow' },
  };
  let res;
  try {
    res = await fetchImpl(`https://${host}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      credentials: 'omit', referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    throw new LoginError('Could not reach EcoFlow from the browser (network error, or EcoFlow does not allow ' +
      'requests from web pages / CORS). Use tools/get-user-id.py on a computer instead.');
  }
  if (!res.ok) throw new LoginError(`EcoFlow returned HTTP ${res.status}`);
  const data = await res.json();
  if (String(data.code) !== '0') throw new LoginError(`Login failed: ${data.message ?? 'unknown error'}`);
  const id = data?.data?.user?.userId;
  if (!id) throw new LoginError('Login succeeded but no user ID was in the response');
  return String(id);
}
