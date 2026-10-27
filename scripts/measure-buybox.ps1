# Measure the geometry of the product-detail buy box in a screenshot or design
# render, so the two can be compared numerically rather than by eye.
#
# Reports, for the stepper row and the Buy Now bar:
#   - left/right edge x positions
#   - widths
#   - the vertical gap between rows
#
# Usage:
#   pwsh scripts/measure-buybox.ps1 -Src <png> [-ScanTop 200] [-ScanBottom 700]
param(
    [Parameter(Mandatory = $true)][string]$Src,
    [int]$ScanTop = 200,
    [int]$ScanBottom = 900
)

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($Src))
$w = $bmp.Width
$h = $bmp.Height
Write-Host "image: $w x $h"

# Both the design and the render show the buy box in the right-hand column.
$scanX0 = [int]($w * 0.44)
$scanX1 = $w - 1

function Get-InkRun {
    param([int]$y)
    $runs = @()
    $inRun = $false
    $start = 0
    for ($x = $script:scanX0; $x -lt $script:scanX1; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $isInk = ($c.R -lt 242 -or $c.G -lt 242 -or $c.B -lt 242)
        if ($isInk -and -not $inRun) { $inRun = $true; $start = $x }
        elseif (-not $isInk -and $inRun) { $inRun = $false; $runs += [pscustomobject]@{ a = $start; b = $x - 1 } }
    }
    if ($inRun) { $runs += [pscustomobject]@{ a = $start; b = $scanX1 - 1 } }
    return $runs
}

# Find the widest horizontal run per row: that identifies full-width bars
# (Buy Now, the Add To Cart border) versus narrow ones (the stepper).
$rows = @()
for ($y = $ScanTop; $y -lt [Math]::Min($ScanBottom, $h); $y++) {
    $runs = Get-InkRun -y $y
    if ($runs.Count -eq 0) { continue }
    $widest = ($runs | Sort-Object { $_.b - $_.a } -Descending)[0]
    $rows += [pscustomobject]@{
        y      = $y
        first  = $runs[0].a
        last   = $runs[-1].b
        runs   = $runs.Count
        widest = $widest.b - $widest.a + 1
    }
}

# A "solid bar" row has essentially one long run.
$bars = $rows | Where-Object { $_.runs -le 2 -and $_.widest -gt ($w * 0.25) }
if ($bars) {
    Write-Host "`nFull-width bar rows (candidate Buy Now / button borders):"
    $bars | Select-Object -First 14 | ForEach-Object {
        Write-Host ("  y={0,4}  x {1,4}..{2,4}  widest={3,4}" -f $_.y, $_.first, $_.last, $_.widest)
    }
}
else {
    Write-Host "`nNo full-width bars found in the scan band."
}

# The stepper row: a row with 2+ separated runs (value cell + divider + arrows
# produce several borders), narrower than the bars.
$steppers = $rows | Where-Object { $_.runs -ge 2 -and $_.last -lt ($w * 0.70) }
if ($steppers) {
    Write-Host "`nCandidate stepper rows (multiple short runs):"
    $steppers | Select-Object -First 12 | ForEach-Object {
        Write-Host ("  y={0,4}  x {1,4}..{2,4}  runs={3}" -f $_.y, $_.first, $_.last, $_.runs)
    }
}
else {
    Write-Host "`nNo stepper row detected."
}

$bmp.Dispose()
