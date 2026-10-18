using System;
using System.Drawing;
using System.Windows.Forms;
class Fixture {
    [STAThread] static void Main() {
        Application.EnableVisualStyles();
        var form = new Form { Text="Dragon Control Integration Fixture", Width=720, Height=500, StartPosition=FormStartPosition.CenterScreen };
        var edit = new TextBox { Left=30, Top=30, Width=400, AccessibleName="Integration input", Text="initial" };
        var password = new TextBox { Left=30, Top=65, Width=400, AccessibleName="Integration password", UseSystemPasswordChar=true, Text="do-not-return-this" };
        var choices = new ListBox { Left=450, Top=30, Width=180, Height=90, AccessibleName="Integration choices" };
        choices.Items.AddRange(new object[] { "Choice A", "Choice B", "Choice C" }); choices.SelectedIndex=0;
        var checkbox = new CheckBox { Left=30, Top=110, Width=250, Text="Integration toggle", AccessibleName="Integration toggle" };
        var label = new Label { Left=30, Top=300, Width=640, Height=80, Text="Ready" };
        var apply = new Button { Left=30, Top=160, Width=170, Height=45, Text="Apply input", AccessibleName="Apply input" };
        apply.Click += (s,e) => { label.Text="Applied: "+edit.Text; };
        var dialog = new Button { Left=230, Top=160, Width=190, Height=45, Text="Open test dialog", AccessibleName="Open test dialog" };
        dialog.Click += (s,e) => {
            var child = new Form { Text="Dragon Control Test Dialog", Width=360, Height=180 };
            var close = new Button { Left=35, Top=35, Width=220, Text="Close test dialog", AccessibleName="Close test dialog" };
            close.Click += (a,b) => child.Close(); child.Controls.Add(close);
            child.Shown += (a,b) => { Console.WriteLine("DIALOG "+child.Handle.ToInt64()); Console.Out.Flush(); };
            child.FormClosed += (a,b) => { Console.WriteLine("DIALOG_CLOSED"); Console.Out.Flush(); };
            child.Show(form);
        };
        form.Controls.AddRange(new Control[] { edit, password, choices, checkbox, apply, dialog, label });
        form.Shown += (s,e) => { Console.WriteLine("READY "+form.Handle.ToInt64()); Console.Out.Flush(); };
        var timer = new Timer { Interval=180000 }; timer.Tick += (s,e) => form.Close(); timer.Start();
        Application.Run(form);
    }
}
