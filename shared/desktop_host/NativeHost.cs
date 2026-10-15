// Windowless pipe adapter. All service decisions remain in the shared Python host.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

class NativeHost {
    static JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Log(string phase) {
        try {File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-host.log"),
            DateTime.UtcNow.ToString("o")+" pid="+Process.GetCurrentProcess().Id+" "+phase+Environment.NewLine);}
        catch { }
    }
    static void Reply(string code) {
        byte[] body=Encoding.UTF8.GetBytes(Json.Serialize(new {ok=false,code=code,error="本地通信组件启动失败，请重新注册 Native Host。"}));
        Stream output=Console.OpenStandardOutput();
        byte[] prefix=BitConverter.GetBytes(body.Length);
        output.Write(prefix,0,4);output.Write(body,0,body.Length);output.Flush();
    }
    static byte[] ReadExact(Stream input,int size) {
        byte[] buffer=new byte[size];int offset=0;
        while(offset<size) {int n=input.Read(buffer,offset,size-offset);if(n==0)throw new EndOfStreamException();offset+=n;}
        return buffer;
    }
    static string Quote(string value) { return "\""+value+"\""; }
    [STAThread]
    static int Main(string[] args) {
        Log("entered args_count="+args.Length);
        try {
            string configPath=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-config.json");
            var config=Json.Deserialize<Dictionary<string,string>>(File.ReadAllText(configPath,Encoding.UTF8));
            string origin="chrome-extension://"+config["extension_id"]+"/";
            if(args.Length<1 || args[0]!=origin || !Regex.IsMatch(config["extension_id"],"^[a-p]{32}$")) {
                Log("origin_rejected");
                Reply("FORBIDDEN_ORIGIN");return 1;
            }
            Stream input=Console.OpenStandardInput();
            Log("origin_verified reading_frame");
            byte[] prefix=ReadExact(input,4);
            int size=BitConverter.ToInt32(prefix,0);
            if(size<1 || size>4096) {Reply("INVALID_REQUEST");return 1;}
            byte[] body=ReadExact(input,size);
            Log("frame_received");
            string root=config["project_root"];
            var start=new ProcessStartInfo {
                FileName=Path.Combine(root,"plugins","context_hygiene",".venv","Scripts","python.exe"),
                Arguments=Quote(Path.Combine(root,"shared","desktop_host","native_host.py"))+" "+Quote(configPath)+" "+Quote(origin),
                WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,
                RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true
            };
            using(Process child=Process.Start(start)) {
                Log("python_started");
                var response=Task.Factory.StartNew(()=> {
                    using(var memory=new MemoryStream()) {child.StandardOutput.BaseStream.CopyTo(memory);return memory.ToArray();}
                });
                var errors=child.StandardError.ReadToEndAsync(); // Drain, never disclose logs to extension.
                child.StandardInput.BaseStream.Write(prefix,0,4);
                child.StandardInput.BaseStream.Write(body,0,body.Length);child.StandardInput.Close();
                if(!child.WaitForExit(45000)) {child.Kill();Log("python_timeout");Reply("HOST_TIMEOUT");return 1;}
                byte[] result=response.Result;
                Log("python_exit="+child.ExitCode+" output_bytes="+result.Length);
                if(result.Length<5 || result.Length>65536) {Reply("HOST_ERROR");return 1;}
                Stream output=Console.OpenStandardOutput();output.Write(result,0,result.Length);output.Flush();
            }
            return 0;
        } catch(Exception error) {Log("error_type="+error.GetType().Name);Reply("HOST_ERROR");return 1;}
    }
}
