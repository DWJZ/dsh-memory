/**
 * Secret detection suite.
 *
 * A false negative stores a credential forever; a false positive refuses a
 * legitimate Memory. Both directions are asserted, because the second one is how
 * a detector quietly becomes useless.
 *
 * Usage: `node test/redact.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { findSecret, findSecretIn, redactText, REDACTED } = await import(pathToFileURL(join(PLUGIN, 'src/redact.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('credential shapes are detected')
const POSITIVE = [
  ['an OpenAI-style key', 'my key is sk-abcdefghijklmnopqrstuvwxyz012345'],
  ['a bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
  ['a PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow=='],
  ['an assigned password', 'password=hunter2secret'],
  ['an assigned api key', 'api_key: "abcdef1234567890"'],
  ['an assigned token', 'token=ghs_abcdefghijklmnopqrst'],
  ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['a Slack token', 'xoxb-1234567890-abcdefghijkl'],
  ['a Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
]
for (const [label, text] of POSITIVE) {
  check(label, findSecret(text) !== undefined)
}

console.log('a high-entropy blob is detected, ordinary material is not')
check('a long mixed-case token is treated as a credential',
  findSecret('value A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0') === 'high-entropy-blob')
check('a lowercase hex commit hash is not',
  findSecret('fixed in commit 3f9a1c2b4d5e6f708192a3b4c5d6e7f80912a3b4') === undefined)
check('a long URL is not',
  findSecret('see https://example.com/a/very/long/path/that/keeps/going/for/a/while/indeed') === undefined)
check('ordinary prose is not',
  findSecret('用户偏好中文解释，技术术语保留英文，修改 YAML 时保持 minimal diff') === undefined)
check('a short hex value is not', findSecret('release 1.2.3 build 4f5e6d') === undefined)
check('an empty string is clean', findSecret('') === undefined)
check('a non-string is clean', findSecret(undefined) === undefined)

console.log('findSecretIn reports which text is offending')
check('a clean set reports nothing', findSecretIn(['a fact', 'a quote']) === undefined)
check('the second text is reported by index', findSecretIn(['a fact', 'token=abcdef123456']).index === 1)
check('the rule name is reported', findSecretIn(['sk-abcdefghijklmnopqrstuvwxyz']).name === 'openai-style-key')
check('a single string is accepted', findSecretIn('sk-abcdefghijklmnopqrstuvwxyz') !== undefined)

console.log('redaction')
const redacted = redactText('key sk-abcdefghijklmnopqrstuvwxyz012345 and token=abcdef123456')
check('the key is gone', !redacted.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))
check('the assigned token is gone', !redacted.includes('abcdef123456'))
check('the placeholder marks the removal', redacted.includes(REDACTED))
check('the surrounding prose survives', redacted.startsWith('key ') && redacted.includes(' and '))
check('redacting twice changes nothing more', redactText(redacted) === redacted)
check('clean text is returned unchanged', redactText('a plain fact') === 'a plain fact')
check('an empty string survives', redactText('') === '')
check('a missing value becomes an empty string', redactText(undefined) === '')

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
