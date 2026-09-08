# Static Windows PowerShell 5.1 / .NET Framework library shared by private files and native commands.
# Loading this library never reads stdin, processes requests, or writes content.
. ([System.IO.Path]::Combine($PSScriptRoot, 'windows-powershell-bootstrap.ps1'))
if (-not ('RadarPrivateFile' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class RadarPrivateFile {
    private const int MaxBytes = 65536;
    private const uint ReadControl = 0x00020000;
    private const uint ReadAttributes = 0x00000080;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint DirectoryAttribute = 0x10;
    private const uint ReparseAttribute = 0x400;
    private static readonly SecurityIdentifier Current = WindowsIdentity.GetCurrent().User;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access;
        public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle file, uint type, uint sections,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);

    private static void Refuse() { throw new UnauthorizedAccessException("Private file required."); }

    private static bool Trusted(SecurityIdentifier sid) {
        return sid != null && (sid.Equals(Current) || sid.Value == "S-1-5-18"
            || sid.Value == "S-1-5-32-544");
    }

    private static void ValidateAcl(RawSecurityDescriptor descriptor, bool directory) {
        if (descriptor.Owner == null || (directory ? !Trusted(descriptor.Owner)
            : !descriptor.Owner.Equals(Current))) Refuse();
        if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0
            || descriptor.DiscretionaryAcl == null || descriptor.DiscretionaryAcl.Count == 0) Refuse();
        // Creating/deleting children and changing directory metadata or security are writes.
        const uint DirectoryWrites = 0x000D0156;
        foreach (GenericAce entry in descriptor.DiscretionaryAcl) {
            QualifiedAce ace = entry as QualifiedAce;
            if (ace == null) Refuse();
            if (directory && (ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
            if (ace.AceQualifier == AceQualifier.AccessDenied) continue;
            if (ace.AceQualifier != AceQualifier.AccessAllowed || ace.IsCallback) Refuse();
            if (Trusted(ace.SecurityIdentifier)) continue;
            uint mask = unchecked((uint)ace.AccessMask);
            // Generic rights must not evade the specific directory-write mask.
            if (!directory || (mask & (DirectoryWrites | 0x50000000)) != 0) Refuse();
        }
    }

    private static void CheckObject(SafeFileHandle handle, bool directory) {
        FileInformation info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((info.Attributes & ReparseAttribute) != 0
            || ((info.Attributes & DirectoryAttribute) != 0) != directory) Refuse();
    }

    private static SafeFileHandle OpenObject(string path, bool directory) {
        uint access = ReadControl | ReadAttributes | (directory ? 0U : 1U);
        // Deny sharing for writes/deletion while checking the opened object.
        SafeFileHandle handle = CreateFileW(path, access, 1, IntPtr.Zero, 3,
            OpenReparsePoint | (directory ? BackupSemantics : 0), IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        try { CheckObject(handle, directory); return handle; }
        catch { handle.Dispose(); throw; }
    }

    private static RawSecurityDescriptor DirectoryAcl(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > MaxBytes) Refuse();
            byte[] bytes = new byte[(int)length];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(descriptor); }
    }

    private static void ValidateFile(FileStream stream) {
        CheckObject(stream.SafeFileHandle, false);
        // GetAccessControl reads the ACL of this exact handle, before any content is read.
        ValidateAcl(new RawSecurityDescriptor(stream.GetAccessControl().GetSecurityDescriptorBinaryForm(), 0), false);
        if (!stream.CanSeek || stream.Length > MaxBytes) Refuse();
    }

    private static FileStream OpenPrivate(string path) {
        SafeFileHandle handle = OpenObject(path, false);
        FileStream stream = null;
        try {
            stream = new FileStream(handle, FileAccess.Read);
            ValidateFile(stream);
            return stream;
        } catch {
            if (stream != null) stream.Dispose(); else handle.Dispose();
            throw;
        }
    }

    private static string LocalPath(string path) {
        if (String.IsNullOrWhiteSpace(path) || path.Length > 32767) Refuse();
        string full = Path.GetFullPath(path);
        if (full.Length < 4 || !Char.IsLetter(full[0]) || full[1] != ':' || full[2] != '\\'
            || full.Substring(2).IndexOf(':') >= 0) Refuse();
        foreach (string part in full.Substring(3).Split('\\')) {
            if (part.Length == 0 || part.EndsWith(".") || part.EndsWith(" ")
                || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) Refuse();
        }
        return full;
    }

    private static DirectorySecurity NewDirectorySecurity() {
        DirectorySecurity security = new DirectorySecurity();
        security.SetOwner(Current);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(Current, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static FileSecurity NewFileSecurity() {
        FileSecurity security = new FileSecurity();
        security.SetOwner(Current);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(Current, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }

    private sealed class Parents : IDisposable {
        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();

        public Parents(string file, bool create) {
            try {
                string path = Path.GetPathRoot(file);
                handles.Add(OpenObject(path, true));
                string relative = Path.GetDirectoryName(file).Substring(path.Length);
                if (relative.Length > 0) foreach (string part in relative.Split('\\')) {
                    path = Path.Combine(path, part);
                    try { handles.Add(OpenObject(path, true)); }
                    catch (Win32Exception error) {
                        if (!create || (error.NativeErrorCode != 2 && error.NativeErrorCode != 3)) throw;
                        ValidatePrivateParent();
                        // Parent is held open and trusted. Existing directory ACLs are never rewritten.
                        Directory.CreateDirectory(path, NewDirectorySecurity());
                        handles.Add(OpenObject(path, true));
                    }
                }
                ValidatePrivateParent();
            } catch { Dispose(); throw; }
        }

        public void ValidatePrivateParent() {
            SafeFileHandle parent = handles[handles.Count - 1];
            CheckObject(parent, true);
            ValidateAcl(DirectoryAcl(parent), true);
        }

        public void Dispose() {
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
            handles.Clear();
        }
    }

    private static bool ValidateExisting(string path) {
        try { using (FileStream stream = OpenPrivate(path)) return true; }
        catch (Win32Exception error) {
            if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return false;
            throw;
        }
    }

    public static string Read(string path) {
        path = LocalPath(path);
        using (Parents parents = new Parents(path, false))
        using (FileStream stream = OpenPrivate(path)) {
            byte[] bytes = new byte[(int)stream.Length];
            int offset = 0;
            while (offset < bytes.Length) {
                int count = stream.Read(bytes, offset, bytes.Length - offset);
                if (count == 0) throw new IOException("Incomplete read.");
                offset += count;
            }
            return Utf8.GetString(bytes);
        }
    }

    public static void Write(string path, string content) {
        path = LocalPath(path);
        if (content == null) Refuse();
        byte[] bytes = Utf8.GetBytes(content);
        if (bytes.Length > MaxBytes) Refuse();
        using (Parents parents = new Parents(path, true)) {
            bool existed = ValidateExisting(path);
            string temporary = Path.Combine(Path.GetDirectoryName(path), ".reset-radar-" + Guid.NewGuid().ToString("N") + ".tmp");
            bool created = false;
            try {
                // A private DACL and explicit current-user owner exist from the instant of creation.
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew,
                    FileSystemRights.Read | FileSystemRights.Write, FileShare.None, 4096,
                    FileOptions.WriteThrough, NewFileSecurity())) {
                    created = true;
                    ValidateFile(stream);
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                parents.ValidatePrivateParent();
                if (ValidateExisting(path) != existed) Refuse();
                // Same-directory native rename is atomic and retains the private temporary DACL.
                // Do not use ReplaceFile: its documented 1176 failure can remove the original.
                uint flags = existed ? 0x00000009U : 0x00000008U;
                if (!MoveFileExW(temporary, path, flags)) throw new Win32Exception(Marshal.GetLastWin32Error());
                created = false;
            } finally {
                // No user file or pre-existing temporary is ever removed during cleanup.
                if (created) { try { File.Delete(temporary); } catch { } }
            }
        }
    }
}
'@ -ErrorAction Stop
}
