# Slice a mockup into readable, upscaled horizontal bands.
#
# The design mockups are only 398-1251px wide with dense UI text, so reading
# them at native size loses detail. This script cuts a screenshot into
# overlapping horizontal bands and upscales each by an integer factor with
# bicubic interpolation, producing images legible enough to transcribe copy.
#
# Usage:
#   pwsh scripts/slice-mockup.ps1 -Name 02-shop -Bands 4 -Scale 3
#   pwsh scripts/slice-mockup.ps1 -Name all
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$SrcRoot,
    [Parameter(Mandatory = $true)][string]$OutRoot,
    [int]$Bands = 4,
    [int]$Scale = 3,
    [int]$Overlap = 40
)

Add-Type -AssemblyName System.Drawing

function Slice-One {
    param([string]$File, [int]$Bands, [int]$Scale, [int]$Overlap)

    $base = [System.IO.Path]::GetFileNameWithoutExtension($File)
    $img = [System.Drawing.Image]::FromFile($File)
    $w = $img.Width
    $h = $img.Height

    # Vertical extent of one band, plus overlap so nothing is cut mid-line.
    $bandH = [Math]::Ceiling($h / $Bands)
    Write-Host ("{0}: {1}x{2}  ->  {3} bands of ~{4}px @ {5}x" -f $base, $w, $h, $Bands, $bandH, $Scale)

    for ($i = 0; $i -lt $Bands; $i++) {
        $y = [Math]::Max(0, ($i * $bandH) - $Overlap)
        $bottom = [Math]::Min($h, (($i + 1) * $bandH) + $Overlap)
        $sliceH = $bottom - $y
        if ($sliceH -le 0) { continue }

        $crop = New-Object System.Drawing.Bitmap $w, $sliceH
        $g = [System.Drawing.Graphics]::FromImage($crop)
        $g.DrawImage(
            $img,
            (New-Object System.Drawing.Rectangle 0, 0, $w, $sliceH),
            (New-Object System.Drawing.Rectangle 0, $y, $w, $sliceH),
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $g.Dispose()

        $bigW = $w * $Scale
        $bigH = $sliceH * $Scale
        $big = New-Object System.Drawing.Bitmap $bigW, $bigH
        $g2 = [System.Drawing.Graphics]::FromImage($big)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g2.DrawImage($crop, 0, 0, $bigW, $bigH)
        $g2.Dispose()

        $outFile = Join-Path $OutRoot ("{0}-b{1}.png" -f $base, $i)
        $big.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host ("  -> {0}  ({1}x{2})" -f (Split-Path $outFile -Leaf), $bigW, $bigH)

        $big.Dispose()
        $crop.Dispose()
    }
    $img.Dispose()
}

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null

if ($Name -eq 'all') {
    Get-ChildItem (Join-Path $SrcRoot '*.png') | Sort-Object Name | ForEach-Object {
        Slice-One -File $_.FullName -Bands $Bands -Scale $Scale -Overlap $Overlap
    }
} else {
    $file = Join-Path $SrcRoot ($Name + '.png')
    if (-not (Test-Path $file)) { throw "Not found: $file" }
    Slice-One -File $file -Bands $Bands -Scale $Scale -Overlap $Overlap
}
