$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$noEnv = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

foreach ($arg in $args) {
	if ($arg -eq "--no-env") {
		$noEnv = $true
	} else {
		$forwardArgs.Add($arg)
	}
}

if ($noEnv) {
	# Credentials for the surviving providers (see packages/ai/src/env-api-keys.ts).
	# Generic OpenAI-compatible endpoints read provider-specific variables configured in
	# models.json, which are not enumerable here; those come from the isolated HOME instead.
	$envVarsToUnset = @(
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN"
	)

	foreach ($name in $envVarsToUnset) {
		Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
	}

	Write-Host "Running without API keys..."
}

# --import takes a module specifier, so pass the resolver as a file URL (Windows paths are not specifiers).
$resolverUrl = ([System.Uri](Join-Path $scriptDir "packages/coding-agent/src/testing/source-resolver.ts")).AbsoluteUri
$cliPath = Join-Path $scriptDir "packages/coding-agent/src/cli.ts"
& node --import $resolverUrl $cliPath @forwardArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
