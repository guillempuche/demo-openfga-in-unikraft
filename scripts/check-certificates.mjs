// Check TLS certificate files before scripts/deploy.sh hands them to the
// instances, so a wrong file fails here with a clear message rather than as a
// TLS error inside an instance:
//   node scripts/check-certificates.mjs <CA file> [<certificate file> <key file> <hostname>]...
//
// The CA file must hold a CA certificate. For each server certificate:
// - it chains to the CA, through any intermediate certificates that follow it
//   in the same file (as certificates from a company CA often do);
// - the key file holds its private key;
// - it is valid for the hostname clients connect to (its subject alternative
//   names, SANs);
// - it hasn't expired (a warning when less than 30 days are left).
// It reads certificates and keys but never prints a key.
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [caFile, ...servers] = process.argv.slice(2)
if (!caFile || servers.length % 3 !== 0) {
  console.error('usage: node scripts/check-certificates.mjs <CA file> [<certificate file> <key file> <hostname>]...')
  process.exit(2)
}

let failed = false
const fail = (message) => {
  console.error(`error: ${message}`)
  failed = true
}

/** Every certificate in a PEM file, in order. */
const certificatesIn = (file) =>
  (readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
    (pem) => new X509Certificate(pem),
  )

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "N days left" for `cert`; fails when it has expired, warns when it soon will. */
function daysLeft(label, cert) {
  const days = Math.floor((Date.parse(cert.validTo) - Date.now()) / 86_400_000)
  if (days < 0) fail(`${label} expired on ${cert.validTo}`)
  else if (days < 30) console.warn(`warning: ${label} expires in ${plural(days, 'day')} (${cert.validTo}); renew it (./scripts/tls.sh --renew)`)
  return `${plural(days, 'day')} left`
}

let ca
try {
  const [first] = certificatesIn(caFile)
  if (!first) throw new Error('no certificate in the file')
  if (!first.ca) throw new Error('not a CA certificate (basicConstraints CA:FALSE)')
  console.log(`ok   ${caFile}: CA "${first.subject.replace(/\n/g, ', ')}", ${daysLeft(caFile, first)}`)
  ca = first
} catch (err) {
  fail(`${caFile}: ${err.message}`)
}

for (let i = 0; ca && i < servers.length; i += 3) {
  const [certFile, keyFile, hostname] = servers.slice(i, i + 3)
  try {
    const chain = certificatesIn(certFile)
    if (chain.length === 0) throw new Error('no certificate in the file')
    // Each certificate is signed by the one after it, the last one by the CA.
    const signers = [...chain.slice(1), ca]
    chain.forEach((cert, j) => {
      if (!cert.verify(signers[j].publicKey)) throw new Error(`not signed by the CA in ${caFile}`)
    })
    const [leaf] = chain
    if (!leaf.checkPrivateKey(createPrivateKey(readFileSync(keyFile)))) throw new Error(`${keyFile} is not its private key`)
    if (!leaf.checkHost(hostname)) throw new Error(`not valid for ${hostname} (it names ${leaf.subjectAltName ?? 'no SANs'})`)
    console.log(`ok   ${certFile}: ${hostname}, ${daysLeft(certFile, leaf)}`)
  } catch (err) {
    fail(`${certFile}: ${err.message}`)
  }
}

process.exit(failed ? 1 : 0)
