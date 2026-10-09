& {
    $ErrorActionPreference = 'Stop'
    $pxProject = 'D:\Working\Project_X'
    $pxSourceFiles = @(
        'sdp-backend\server.js',
        'sdp-backend\voice-profile-status.js',
        'sdp-backend\voice-transfer-queue.js',
        'sdp-backend\voice-phone-flow.js',
        'sdp-backend\public\voice-capture.html',
        'sdp-backend\public\consent.html',
        'sdp-backend\config\capture-sections.json',
        'sdp-backend\tools\auto_transfer_voice_sessions.py',
        'sdp-backend\tools\transfer_voice_session.py',
        'sdp-backend\tools\phone_sequence_worker.py',
        'PX_Engine\Modules\PXM-019\voice_model_training_engine.py',
        'PX_Engine\Modules\PXM-019\key_bracket_portal.py',
        'PX_Engine\Modules\PXM-019\calibration_bracket_engine.py',
        'PX_Engine\Modules\PXM-019\Calibration_Policy.json',
        'PX_Engine\Modules\PXM-019\live_training_monitor.py',
        'PX_Engine\Services\PX_Admin\px_customer_training_executive.py',
        'PX_Engine\Services\PX_Admin\px_customer_training_intake.py',
        'PX_Engine\Services\PX_Admin\px_voice_certification_handoff.py',
        'PX_Engine\Services\PX_Admin\px_wix_customer_link.py',
        'PX_Engine\Engine\px_customer_pitch_profiles.py'
    )
    $pxTemp = Join-Path $env:TEMP ('PX_Phone_Source_' + [guid]::NewGuid().ToString('N'))
    $pxDesktop = [Environment]::GetFolderPath('Desktop')
    $pxZip = Join-Path $pxDesktop ('PX_Phone_Sequence_Source_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.zip')
    try {
        foreach ($pxRelative in $pxSourceFiles) {
            $pxFrom = Join-Path $pxProject $pxRelative
            if (-not (Test-Path -LiteralPath $pxFrom -PathType Leaf)) { throw "Required source file missing: $pxFrom" }
            $pxTo = Join-Path $pxTemp $pxRelative
            New-Item -ItemType Directory -Path (Split-Path -Parent $pxTo) -Force | Out-Null
            Copy-Item -LiteralPath $pxFrom -Destination $pxTo
        }
        Compress-Archive -Path (Join-Path $pxTemp '*') -DestinationPath $pxZip
        Write-Output "SOURCE PACKAGE READY: $pxZip"
        Write-Output 'Code and capture configuration only. No recordings, database, tokens or model weights included.'
    } finally {
        if (Test-Path -LiteralPath $pxTemp) { Remove-Item -LiteralPath $pxTemp -Recurse -Force }
    }
}
