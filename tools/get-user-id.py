"""One-off helper: print your EcoFlow numeric user ID (needed to authenticate over BLE).

Logs in to the same endpoint the EcoFlow app uses and prints ONLY the user ID. Your password
is typed at a prompt, sent to api.ecoflow.com over HTTPS, and never stored. Run it locally.
Based on the login flow in rabits/ha-ef-ble (Apache-2.0). NOT TESTED against the live service
yet -- if it fails, the Home Assistant ha-ef-ble config flow can fetch the same ID.

Usage: python3 -I tools/get-user-id.py you@example.com
"""
import base64, getpass, json, sys, urllib.request

email = sys.argv[1]
body = json.dumps({
    'scene': 'IOT_APP', 'appVersion': '1.0.0', 'userType': 'ECOFLOW', 'email': email,
    'password': base64.b64encode(getpass.getpass('EcoFlow password: ').encode()).decode(),
    'oauth': {'bundleId': 'com.ef.EcoFlow'},
}).encode()
req = urllib.request.Request('https://api.ecoflow.com/auth/login', body, {'Content-Type': 'application/json'})
with urllib.request.urlopen(req, timeout=20) as r:
    data = json.load(r)
if str(data.get('code')) != '0':
    sys.exit(f"login failed: {data.get('message')}")
print(data['data']['user']['userId'])
