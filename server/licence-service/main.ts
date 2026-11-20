#!/usr/bin/env node
/**
 * The Appbuilder licence service (hosting phase, package H-G): `node server/licence-service/main.ts <command>`.
 * A separate process with its own PostgreSQL database; it needs nothing of a product install. Commands: cli.ts.
 *
 *   APPBUILDER_LICENCE_DB_URL            postgres://user:password@host:port/ab_licence (its own database and role)
 *   APPBUILDER_LICENCE_SIGNING_KEY       the private key file made by `keygen` (never in the repository)
 *   APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE (or _KEY_PASSPHRASE)  the key's passphrase
 *   APPBUILDER_LICENCE_HOST / _PORT      listen address (127.0.0.1:7090); _TLS_CERT / _TLS_KEY for HTTPS without a proxy
 *   APPBUILDER_LICENCE_TRUST_PROXY=1     the client address is the X-Forwarded-For entry of the local proxy
 *   APPBUILDER_LICENCE_RATE_PER_MIN      checks per client address per minute (30)
 */
import { runLicenceCli } from './cli.ts'

process.exit(await runLicenceCli(process.argv.slice(2)))
