using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
class Launcher {
 const string Url = "http://127.0.0.1:5178/";
 static bool Ready() {
  try {
   var req = (HttpWebRequest)WebRequest.Create(Url + "api/settings");
   req.Timeout = 1000;
   req.Proxy = null;
   using (var res = (HttpWebResponse)req.GetResponse())
    return res.StatusCode == HttpStatusCode.OK && res.ContentType.Contains("application/json");
  } catch { return false; }
 }
 [STAThread] static int Main(string[] args) {
  Process ownedServer = null;
  try {
   using (var mutex = new Mutex(false, @"Local\LectureLensLauncher")) {
    bool acquired;
    try { acquired = mutex.WaitOne(45000); } catch (AbandonedMutexException) { acquired = true; }
    if (!acquired) throw new Exception("다른 실행 작업이 진행 중입니다. 잠시 후 다시 실행하세요.");
    try {
     if (!Ready()) {
      string root = AppDomain.CurrentDomain.BaseDirectory;
      if (!File.Exists(Path.Combine(root, "server", "index.ts"))) root = @"C:\Project\video_study";
      if (!File.Exists(Path.Combine(root, "node_modules", "tsx", "package.json")) || !File.Exists(Path.Combine(root, "web", "dist", "index.html")))
       throw new Exception("앱 파일을 찾을 수 없습니다. C:\\Project\\video_study 폴더를 유지해주세요.");
      string node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
      if (!File.Exists(node)) node = "node.exe";
      var info = new ProcessStartInfo(node, "--import tsx server/index.ts");
      info.WorkingDirectory = root;
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      info.RedirectStandardError = true;
      info.RedirectStandardOutput = true;
      info.EnvironmentVariables["LECTURE_API_PORT"] = "5178";
      var process = new Process();
      process.StartInfo = info;
      string errorLog = Path.Combine(root, "launcher-error.log");
      process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
       if (e.Data != null) { try { File.AppendAllText(errorLog, e.Data + Environment.NewLine); } catch {} }
      };
      process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {};
      process.Start();
      ownedServer = process;
      process.BeginErrorReadLine();
      process.BeginOutputReadLine();
      var timer = Stopwatch.StartNew();
      while (!Ready()) {
       if (process.HasExited) {
        if (Ready()) break;
        throw new Exception("앱 서버가 종료되었습니다. 오류 기록: " + errorLog);
       }
       if (timer.ElapsedMilliseconds > 45000) throw new Exception("앱 시작 시간이 초과되었습니다. 5178 포트 사용 여부를 확인해주세요.");
       Thread.Sleep(250);
      }
     }
     if (Array.IndexOf(args, "--no-browser") < 0) Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
    } finally { mutex.ReleaseMutex(); }
   }
   // Keep draining the server's redirected streams for its entire lifetime.
   // Release the startup mutex first so subsequent launches can open the page.
   if (ownedServer != null) ownedServer.WaitForExit();
   return 0;
  } catch (Exception ex) {
   MessageBox.Show(ex.Message, "Lecture Lens", MessageBoxButtons.OK, MessageBoxIcon.Error);
   return 1;
  }
 }
}
