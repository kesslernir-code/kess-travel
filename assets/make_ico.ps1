Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\user\Documents\Kessler trip planner\Trip Planner\assets\kess-trip-icon.png"
$icoPath = "C:\Users\user\Documents\Kessler trip planner\Trip Planner\assets\kess-trip.ico"

$sizes = @(16, 32, 48, 128, 256)
$src = [System.Drawing.Image]::FromFile($srcPath)

$pngBlobs = @()
foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs += ,@{ Size = $size; Bytes = $ms.ToArray() }
    $bmp.Dispose()
}
$src.Dispose()

$fs = New-Object System.IO.FileStream $icoPath, "Create"
$bw = New-Object System.IO.BinaryWriter $fs

# ICONDIR header
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type = icon
$bw.Write([UInt16]$pngBlobs.Count)

$dataOffset = 6 + (16 * $pngBlobs.Count)
foreach ($entry in $pngBlobs) {
    $s = $entry.Size
    $bw.Write([Byte]($(if ($s -eq 256) { 0 } else { $s })))   # width (0 means 256)
    $bw.Write([Byte]($(if ($s -eq 256) { 0 } else { $s })))   # height
    $bw.Write([Byte]0)        # color palette
    $bw.Write([Byte]0)        # reserved
    $bw.Write([UInt16]1)      # color planes
    $bw.Write([UInt16]32)     # bits per pixel
    $bw.Write([UInt32]$entry.Bytes.Length)
    $bw.Write([UInt32]$dataOffset)
    $dataOffset += $entry.Bytes.Length
}
foreach ($entry in $pngBlobs) {
    $bw.Write($entry.Bytes)
}
$bw.Flush()
$bw.Close()
$fs.Close()

"Wrote $icoPath"
