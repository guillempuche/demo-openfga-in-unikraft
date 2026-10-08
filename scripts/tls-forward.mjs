// A local TLS client for scripts/tunnel.sh. It listens in plain text on this
// machine's loopback interface and forwards each connection over TLS to a
// tunnel port, checking OpenFGA's certificate against the CA and the
// instance's private name. Tools that can't be given a CA (the fga CLI on
// macOS reads trust only from the system keychain) then talk plain HTTP or
// gRPC to localhost, and only that hop, which never leaves the machine, is
// unencrypted: the pattern of Google's Cloud SQL Auth Proxy.
//   node scripts/tls-forward.mjs <listen port> <tunnel port> <server name> <CA file> <ALPN protocol>
// The ALPN protocol is the one agreed during the TLS handshake: http/1.1 for
// OpenFGA's HTTP API, h2 for gRPC (HTTP/2).
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { connect } from 'node:tls'

const [listenPort, tunnelPort, servername, caFile, alpn] = process.argv.slice(2)
if (!alpn) {
  console.error('usage: node scripts/tls-forward.mjs <listen port> <tunnel port> <server name> <CA file> <ALPN protocol>')
  process.exit(2)
}
const ca = readFileSync(caFile)

const server = createServer((local) => {
  const remote = connect({ host: '127.0.0.1', port: Number(tunnelPort), servername, ca, ALPNProtocols: [alpn] })
  // The local side's bytes wait (the socket stays paused) until the handshake
  // has verified the certificate.
  remote.once('secureConnect', () => local.pipe(remote).pipe(local))
  remote.on('error', (err) => {
    console.error(`tls-forward localhost:${listenPort}: ${err.message}`)
    local.destroy()
  })
  local.on('error', () => remote.destroy())
  local.on('close', () => remote.destroy())
  remote.on('close', () => local.destroy())
})
server.listen(Number(listenPort), '127.0.0.1', () =>
  console.log(`tls-forward: localhost:${listenPort} -> TLS to ${servername} (${alpn}) via localhost:${tunnelPort}`),
)
// tunnel.sh stops everything with one SIGTERM.
process.on('SIGTERM', () => process.exit(0))
