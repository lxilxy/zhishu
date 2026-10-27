# Crop the top portion of a lifestyle photo so the baked-in headline text
# (which sits in the lower half of the source renders) is excluded.
#
# Usage:
#   pwsh scripts/crop-top.ps1 -Src <in.png> -Dest <out.png> -KeepTop 0.5
param(
    [Parameter(Mandatory = $true)][string]$Src,
    [Parameter(Mandatory = $true)][string]$Dest,
    [double]$KeepTop = 0.5,
    [int]$OutWidth = 800
)

Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile($Src)
$w = $img.Width
$h = $img.Height
$keepH = [int][Math]::Round($h * $KeepTop)

$crop = New-Object System.Drawing.Bitmap -ArgumentList @($w, $keepH)
$g = [System.Drawing.Graphics]::FromImage($crop)
$destRect = New-Object System.Drawing.Rectangle -ArgumentList @(0, 0, $w, $keepH)
$srcRect = New-Object System.Drawing.Rectangle -ArgumentList @(0, 0, $w, $keepH)
$g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

$outH = [int][Math]::Round($OutWidth * $keepH / $w)
$scaled = New-Object System.Drawing.Bitmap -ArgumentList @($OutWidth, $outH)
$g2 = [System.Drawing.Graphics]::FromImage($scaled)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($crop, 0, 0, $OutWidth, $outH)
$g2.Dispose()

$scaled.Save($Dest, [System.Drawing.Imaging.ImageFormat]::Png)
$scaled.Dispose()
$crop.Dispose()
$img.Dispose()

Write-Host ("{0} -> {1}x{2} (top {3}%)" -f (Split-Path $Dest -Leaf), $OutWidth, $outH, [int]($KeepTop * 100))
