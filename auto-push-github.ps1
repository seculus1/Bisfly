$repo = $PSScriptRoot
$remote = "origin"
$branch = "main"

if (-not (Test-Path (Join-Path $repo ".git"))) {
    throw "Git repository not found in: $repo"
}

git -C $repo config user.name "Seculus1" 2>$null
git -C $repo config user.email "bisflytravels@gmail.com" 2>$null

Write-Host "Watching for changes in: $repo"
Write-Host "Auto-push will trigger when file changes are detected."

while ($true) {
    $status = git -C $repo status --porcelain

    if ($status) {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git -C $repo add .

        try {
            git -C $repo commit -m "Auto update $timestamp"
        }
        catch {
            Write-Host "No new commit created or commit failed: $_"
        }

        try {
            git -C $repo push $remote $branch
            Write-Host "Pushed to GitHub at $timestamp"
        }
        catch {
            Write-Host "Push failed: $_"
        }
    }

    Start-Sleep -Seconds 20
}
