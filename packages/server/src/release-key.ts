// The public half of the update key (G36.19), the same key as the Windows launcher's
// UpdateKey.cs: it checks the signature of a release's release.json, so a release's kind
// (mandatory, breaking) counts only when it was signed by whoever holds the UPDATE_SIGNING_KEY
// secret. Written by `node packaging/update/keygen.mjs`; sign.mjs refuses a secret that is not
// this key's private half. Empty: the kind of every release is ignored (normal).
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAmpVtgHyQOGFUMbOO+pc6
sZqcebFuyJ6MiEl4JT0dkiKS4dSY356lpcq7n2eGV97Ev1XcS0ulj9tD4NI+QjXn
d19l6kZ1CALz9SDpFtUJXQ+iXgOFepiBosdQM4IIANA8k073TNR0LciY33sOGlCM
xL1yKiJBf4j9pJpbrmGJf+7p/SMXnnx+LNz4gHAVn3lOoedcOU/8/Z3zsOuQE4nH
7ySI+fFwQ4iW4hqXmPXCNNVQPCU3N7S39xgzh2v5GdlKcBP00X0WD96NS1l4iapU
UGNukMPo5YN1Ihp5FC4wjTcMqMWDI9bNDUoLP9vEekMqNNEWMUEsXamDH4Cm3QDl
WHFR98PmrQZZPX8Rwzbz8c+2riP1O6K7zL9zGLboxwFpdMVFilx7ggYZDx+7R93q
OWg1a3mqCKuTEZlCCDgbR8Inyi4uCsjTjtUF5wpL+38ApRXIJt3hVuVcu3IukFji
sGbARheBFA8dRhrLDaHF1s1KhV1e4MW3cGIDZusf8WTHAgMBAAE=
-----END PUBLIC KEY-----`;
