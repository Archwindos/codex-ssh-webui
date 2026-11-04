using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Compiled locally by windows.ps1; stdin, argv and environment never carry a password.
public static class DesktopAskPass {
    public static string Classify(string prompt, string expectedPrompt) {
        if (!String.IsNullOrEmpty(expectedPrompt) && !Regex.IsMatch(expectedPrompt, "[\\r\\n]") && expectedPrompt.EndsWith("'s password:", StringComparison.Ordinal) &&
            (String.Equals(prompt, expectedPrompt, StringComparison.Ordinal) || String.Equals(prompt, expectedPrompt + " ", StringComparison.Ordinal))) return "password";
        if (prompt.Contains("Are you sure you want to continue connecting") && Regex.IsMatch(prompt, "fingerprint is SHA256:[A-Za-z0-9+/=]+")) return "hostkey";
        return "reject";
    }

    [STAThread]
    public static int Main(string[] args) {
        byte[] plain = null;
        try {
            if (args.Length != 1) return 1;
            string path = Environment.GetEnvironmentVariable("CODEX_WEBUI_CREDENTIAL_FILE");
            plain = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser);
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(plain));
            string expectedPrompt = Environment.GetEnvironmentVariable("CODEX_WEBUI_PASSWORD_PROMPT");
            if (String.IsNullOrEmpty(expectedPrompt) || !expectedPrompt.StartsWith((string)config["user"] + "@", StringComparison.Ordinal)) return 1;
            string kind = Classify(args[0], expectedPrompt);
            string result;
            if (kind == "password") result = (string)config["password"];
            else if (kind == "hostkey") {
                DialogResult answer = MessageBox.Show(args[0], "Verify SSH server fingerprint", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer != DialogResult.Yes) return 1;
                result = "yes";
            } else return 1;
            byte[] output = Encoding.UTF8.GetBytes(result + "\n");
            try { using (Stream stdout = Console.OpenStandardOutput()) { stdout.Write(output, 0, output.Length); } }
            finally { Array.Clear(output, 0, output.Length); }
            return 0;
        } catch { return 1; }
        finally { if (plain != null) Array.Clear(plain, 0, plain.Length); }
    }
}
