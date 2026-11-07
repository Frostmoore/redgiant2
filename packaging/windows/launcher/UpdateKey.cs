// The public key that checks the update manifests' signature (G36.18), as .NET's RSA XML. Empty:
// manifests are checked only against the sha256 GitHub's API gives for them (digest). Filled by
// `node packaging/update/keygen.mjs`, whose private half becomes the UPDATE_SIGNING_KEY secret of
// the repository; from then on an unsigned or badly signed manifest is refused (the full
// installer is offered instead) and release.yml refuses to publish without the secret.
static class UpdateKey
{
    public static readonly string PublicKeyXml = "";
}
