// electron-builder afterSign hook. Without a Developer ID the app is left
// with a broken signature, which Apple Silicon Macs and the Keychain (used to
// encrypt the API key) reject. An ad-hoc signature is enough to run it locally.
const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
