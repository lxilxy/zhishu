# Print, for a single horizontal band, the ink runs on each row. Used to read
# off exact element edges in a design render or a screenshot.
#
# Usage:
#   pwsh scripts/scan-rows.ps1 -Src <png> -X0 360 -X1 810 -Y0 285 -Y1 335
param(
    [Parameter(Mandatory = $true)][string]$Src,
    [int]$X0 = 0,
    [int]$X1 = 0,
    [int]$Y0 = 0,
    [int]$Y1 = 100,
    [int]$Threshold = 242,
    [switch]$OnlyChanges
)

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($Src))
if ($X1 -le 0 -or $X1 -gt $bmp.Width) { $X1 = $bmp.Width - 1 }

$prev = ''
for ($y = $Y0; $y -le [Math]::Min($Y1, $bmp.Height - 1); $y++) {
    $runs = @()
    $inRun = $false
    $start = 0
    for ($x = $X0; $x -lt $X1; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $isInk = ($c.R -lt $Threshold -or $c.G -lt $Threshold -or $c.B -lt $Threshold)
        if ($isInk -and -not $inRun) { $inRun = $true; $start = $x }
        elseif (-not $isInk -and $inRun) { $inRun = $false; $runs += "$start-$($x-1)" }
    }
    if ($inRun) { $runs += "$start-$($X1-1)" }

    $line = $runs -join '  '
    if ($OnlyChanges -and $line -eq $prev) { continue }
    $prev = $line
    Write-Host ("y={0,4}  {1}" -f $y, $line)
}

$bmp.Dispose()
