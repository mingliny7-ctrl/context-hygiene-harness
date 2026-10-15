"""Windowed entry point; closing the window does not terminate backend services."""
from pathlib import Path
import queue
import sys
import threading
import tkinter as tk
from tkinter import messagebox, ttk

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from shared.desktop_host.launcher import Launcher, LaunchBusy


def main():
    window=tk.Tk()
    window.title('Context Harness · 本地服务')
    window.geometry('690x320')
    window.minsize(600,300)
    frame=ttk.Frame(window,padding=20)
    frame.pack(fill='both',expand=True)
    heading=ttk.Label(frame,text='正在检查并启动本地服务…',font=('Microsoft YaHei UI',12))
    heading.pack(anchor='w',pady=(0,14))
    labels={}
    for name in ('Collector','Atlas'):
        labels[name]=ttk.Label(frame,text=name+'：等待检查',wraplength=640)
        labels[name].pack(anchor='w',pady=7)
    launcher=Launcher()
    ttk.Label(frame,text='诊断日志：'+str(launcher.log_dir),wraplength=640).pack(anchor='w',pady=12)
    ttk.Label(frame,text='Atlas：http://127.0.0.1:4173/\n关闭本窗口后，已启动的服务继续运行。').pack(anchor='w')
    ttk.Button(frame,text='关闭',command=window.destroy).pack(anchor='e',pady=8)
    events=queue.Queue()

    def work():
        try:
            events.put(('done',launcher.run(notify=lambda r:events.put(('service',r)))))
        except LaunchBusy as error:
            events.put(('busy',str(error)))
        except Exception as error:
            events.put(('error',f'{type(error).__name__}：{error}'))

    def poll():
        try:
            while True:
                kind,value=events.get_nowait()
                if kind=='service':
                    labels[value['service']].configure(text=value['service']+'：'+value['detail'])
                elif kind=='done':
                    heading.configure(text='两个服务均已就绪' if value['status']=='ready' else '启动未完成：请查看各服务状态和日志')
                elif kind=='busy':
                    heading.configure(text='已有启动检查正在进行')
                    messagebox.showinfo('启动检查',value,parent=window)
                else:
                    heading.configure(text='启动器发生错误')
                    messagebox.showerror('启动失败',value,parent=window)
        except queue.Empty:
            pass
        window.after(150,poll)

    # Non-daemon: even closing the window during startup completes bounded checks.
    threading.Thread(target=work,daemon=False).start()
    window.after(150,poll)
    window.mainloop()


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None,f'Launcher failed: {type(error).__name__}: {error}','Context Harness',16)
