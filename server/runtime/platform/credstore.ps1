# Windows Credential Manager helper for RaceIQ
# Usage: powershell -File credstore.ps1 <action> <target> [value] [outfile]
param(
  [string]$Action,
  [string]$Target,
  [string]$Value,
  [string]$OutFile
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCred {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static bool Write(string target, string secret) {
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = 1;
        cred.TargetName = target;
        cred.CredentialBlobSize = (uint)bytes.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, cred.CredentialBlob, bytes.Length);
        cred.Persist = 2;
        cred.UserName = "RaceIQ";
        bool ok = CredWriteW(ref cred, 0);
        Marshal.FreeHGlobal(cred.CredentialBlob);
        return ok;
    }

    public static string Read(string target) {
        IntPtr credPtr;
        if (!CredReadW(target, 1, 0, out credPtr)) return "";
        CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
        byte[] bytes = new byte[cred.CredentialBlobSize];
        Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
        CredFree(credPtr);
        return Encoding.Unicode.GetString(bytes);
    }

    public static bool Delete(string target) {
        return CredDeleteW(target, 1, 0);
    }
}
"@

switch ($Action) {
    "write" {
        [WinCred]::Write($Target, $Value) | Out-Null
    }
    "read" {
        $result = [WinCred]::Read($Target)
        if ($OutFile) {
            [IO.File]::WriteAllText($OutFile, $result)
        } else {
            Write-Output $result
        }
    }
    "delete" {
        [WinCred]::Delete($Target) | Out-Null
    }
}
