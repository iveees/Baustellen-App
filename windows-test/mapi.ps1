# Mail über Simple MAPI an das Standard-Mailprogramm übergeben (mit Anhängen)
param([string]$JobDatei)
$job = Get-Content -Raw -Encoding UTF8 $JobDatei | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Mapi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiMessageW { public int reserved; public string subject; public string noteText; public string messageType; public string dateReceived; public string conversationID; public int flags; public IntPtr originator; public int recipCount; public IntPtr recips; public int fileCount; public IntPtr files; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiRecipDescW { public int reserved; public int recipClass; public string name; public string address; public int eIDSize; public IntPtr entryID; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiFileDescW { public int reserved; public int flags; public int position; public string pathName; public string fileName; public IntPtr fileType; }
  [DllImport("MAPI32.DLL", CharSet = CharSet.Unicode)]
  public static extern int MAPISendMailW(IntPtr session, IntPtr uiParam, MapiMessageW message, int flags, int reserved);
  public static int Send(string[] to, string subject, string body, string[] files) {
    var msg = new MapiMessageW { subject = subject, noteText = body };
    int rs = Marshal.SizeOf(typeof(MapiRecipDescW));
    msg.recips = Marshal.AllocHGlobal(rs * Math.Max(1, to.Length));
    for (int i = 0; i < to.Length; i++) Marshal.StructureToPtr(new MapiRecipDescW { recipClass = 1, name = to[i], address = "SMTP:" + to[i] }, (IntPtr)((long)msg.recips + i * rs), false);
    msg.recipCount = to.Length;
    int fs = Marshal.SizeOf(typeof(MapiFileDescW));
    msg.files = Marshal.AllocHGlobal(fs * Math.Max(1, files.Length));
    for (int i = 0; i < files.Length; i++) Marshal.StructureToPtr(new MapiFileDescW { position = -1, pathName = files[i], fileName = System.IO.Path.GetFileName(files[i]) }, (IntPtr)((long)msg.files + i * fs), false);
    msg.fileCount = files.Length;
    // MAPI_LOGON_UI (0x1) | MAPI_DIALOG (0x8): Entwurf anzeigen, nicht direkt senden
    return MAPISendMailW(IntPtr.Zero, IntPtr.Zero, msg, 0x1 | 0x8, 0);
  }
}
"@
$code = [Mapi]::Send([string[]]$job.to, [string]$job.subject, [string]$job.body, [string[]]$job.files)
if ($code -eq 0) { "OK (Code 0)" } elseif ($code -eq 1) { "Vom Benutzer abgebrochen (Code 1)" } else { "MAPI-Fehlercode $code" }
