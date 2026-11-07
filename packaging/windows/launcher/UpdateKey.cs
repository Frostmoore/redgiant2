// The public key that checks the update manifests' signature (G36.18), as .NET's RSA XML. Empty:
// manifests are checked only against the sha256 GitHub's API gives for them (digest). Filled by
// `node packaging/update/keygen.mjs`, whose private half becomes the UPDATE_SIGNING_KEY secret of
// the repository; from then on an unsigned or badly signed manifest is refused (the full
// installer is offered instead) and release.yml refuses to publish without the secret.
static class UpdateKey
{
    public static readonly string PublicKeyXml = "<RSAKeyValue><Modulus>mpVtgHyQOGFUMbOO+pc6sZqcebFuyJ6MiEl4JT0dkiKS4dSY356lpcq7n2eGV97Ev1XcS0ulj9tD4NI+QjXnd19l6kZ1CALz9SDpFtUJXQ+iXgOFepiBosdQM4IIANA8k073TNR0LciY33sOGlCMxL1yKiJBf4j9pJpbrmGJf+7p/SMXnnx+LNz4gHAVn3lOoedcOU/8/Z3zsOuQE4nH7ySI+fFwQ4iW4hqXmPXCNNVQPCU3N7S39xgzh2v5GdlKcBP00X0WD96NS1l4iapUUGNukMPo5YN1Ihp5FC4wjTcMqMWDI9bNDUoLP9vEekMqNNEWMUEsXamDH4Cm3QDlWHFR98PmrQZZPX8Rwzbz8c+2riP1O6K7zL9zGLboxwFpdMVFilx7ggYZDx+7R93qOWg1a3mqCKuTEZlCCDgbR8Inyi4uCsjTjtUF5wpL+38ApRXIJt3hVuVcu3IukFjisGbARheBFA8dRhrLDaHF1s1KhV1e4MW3cGIDZusf8WTH</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";
}
