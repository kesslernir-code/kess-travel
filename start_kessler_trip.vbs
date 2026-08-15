' KESSLER_TRIP desktop launcher
' -----------------------------------------------------------------------
' What the desktop shortcut actually points to. Runs launch_kessler_trip.js
' with node.exe, with no console window (the "0" below), and doesn't wait
' for it to finish. See launch_kessler_trip.js for what it actually does.

Set objFSO = CreateObject("Scripting.FileSystemObject")
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
jsPath = objFSO.BuildPath(scriptDir, "launch_kessler_trip.js")

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not objFSO.FileExists(nodeExe) Then
  nodeExe = "node.exe" ' fall back to PATH if the usual install location has moved
End If

Set objShell = CreateObject("WScript.Shell")
objShell.Run """" & nodeExe & """ """ & jsPath & """", 0, False
