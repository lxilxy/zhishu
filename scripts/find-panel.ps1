# Find a solid light-grey panel in an image and report its bounds and ratio.
#
# The product detail page's "Guaranteed Safe Checkout" block is a filled grey
# rectangle. This locates it by scanning for the most common near-white-but-not-
# white tone and reporting the bounding box of that exact colour.
#
# Usage:
#   pwsh scripts/find-panel.ps1 -Src <png> [-X0 0] [-X1 0] [-Y0 0] [-Y1 0] [-Tol 5]
param(
    [Parameter(Mandatory = $true)][string]$Src,
    [int]$X0 = 0,
    [int]$X1 = 0,
    [int]$Y0 = 0,
    [int]$Y1 = 0,
    [int]$Tol = 5
)

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($Src))
if ($X1 -le 0 -or $X1 -gt $bmp.Width) { $X1 = $bmp.Width - 1 }
if ($Y1 -le 0 -or $Y1 -gt $bmp.Height) { $Y1 = $bmp.Height - 1 }

# Tally colours that are grey-ish: low saturation, not pure white, not dark.
$tally = @{}
for ($y = $Y0; $y -le $Y1; $y++) {
    for ($x = $X0; $x -le $X1; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $mx = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
        $mn = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
        if (($mx - $mn) -gt 8) { continue }        # saturated
        if ($c.R -lt 200) { continue }             # dark
        if ($c.R -gt 253 -and $c.G -gt 253 -and $c.B -gt 253) { continue }  # white
        $k = "$($c.R),$($c.G),$($c.B)"
        if ($tally.ContainsKey($k)) { $tally[$k]++ } else { $tally[$k] = 1 }
    }
}

if ($tally.Count -eq 0) { Write-Host "no panel-like grey found"; $bmp.Dispose(); exit }

$top = $tally.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
$parts = $top.Key -split ','
$tr = [int]$parts[0]; $tg = [int]$parts[1]; $tb = [int]$parts[2]
Write-Host "dominant grey: rgb($tr,$tg,$tb)  x$($top.Value)"

# Bounding box of that colour (+/- tolerance).
$minX = [int]::MaxValue; $maxX = -1; $minY = [int]::MaxValue; $maxY = -1
for ($y = $Y0; $y -le $Y1; $y++) {
    for ($x = $X0; $x -le $X1; $x++) {
        $c = $bmp.GetPixel($x, $y)
        if ([Math]::Abs($c.R - $tr) -le $Tol -and [Math]::Abs($c.G - $tg) -le $Tol -and [Math]::Abs($c.B - $tb) -le $Tol) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}

$pw = $maxX - $minX + 1
$ph = $maxY - $minY + 1
Write-Host "panel: x $minX..$maxX (w=$pw)   y $minY..$maxY (h=$ph)"
Write-Host "  ratio w/h        = $([Math]::Round($pw / $ph, 2))"
Write-Host "  width  / image   = $([Math]::Round(100.0 * $pw / $bmp.Width, 1))%"
Write-Host "  height / image   = $([Math]::Round(100.0 * $ph / $bmp.Height, 1))%"

$bmp.Dispose()
