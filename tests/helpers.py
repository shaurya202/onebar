"""Constants shared by the test modules.

Kept out of conftest.py so test modules can import them without importing the
conftest a second time under a different module name.
"""

# A device header is required on every write. Tests that do not care about identity
# still need one; tests that do care compare against a second device.
DEVICE_A = {"X-OneBar-Device": "test-device-aaaaaaaa"}
DEVICE_B = {"X-OneBar-Device": "test-device-bbbbbbbb"}

# Destructive endpoints are operator-gated. The suite configures a token so both the
# authorised and the unauthorised path are exercised.
ADMIN_TOKEN = "test-operator-token"
ADMIN = {"X-OneBar-Admin": ADMIN_TOKEN}
