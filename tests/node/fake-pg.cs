using System;
using System.IO;
using System.Threading;
class FakePg {
 static int Main(string[] args) {
  string root=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
  string name=Path.GetFileNameWithoutExtension(System.Reflection.Assembly.GetExecutingAssembly().Location);
  if(Environment.GetEnvironmentVariable("PGPASSWORD")!="SENTINEL password")return 2;
  File.WriteAllText(Path.Combine(root,"tls.txt"),(Environment.GetEnvironmentVariable("PGSSLMODE")??"")+"|"+(Environment.GetEnvironmentVariable("PGSSLROOTCERT")??""));
  Func<string,bool> flag=x=>File.Exists(Path.Combine(root,x));
  string record=String.Join("|",args)+"\n";
  foreach(string k in new[]{"PGOPTIONS","PGSERVICE","PGSERVICEFILE","PGPASSFILE","PGHOSTADDR","BOT_TOKEN","INVITATION_SECRET","WEBHOOK_SECRET","DATABASE_URL","NODE_OPTIONS"}) if(Environment.GetEnvironmentVariable(k)!=null)record+="LEAK:"+k+"\n";
  File.AppendAllText(Path.Combine(root,"calls.txt"),name+":"+record);
  if(args.Length==1&&args[0]=="--version"){Console.WriteLine(name+" (PostgreSQL) "+(flag("old")?"17.9":"18.6"));return 0;}
  if(name=="psql") {
   string query=args[args.Length-1];
   if(query.Contains("server_version_num")) Console.WriteLine("{\"database\":\""+Environment.GetEnvironmentVariable("PGDATABASE")+"\",\"version\":180006}");
   else if(query.Contains("schema_migrations"))Console.WriteLine(File.ReadAllText(Path.Combine(root,"migrations.json")));
   else if(query.Contains("pg_depend"))Console.WriteLine(flag("cross")?"1":"0");
   else Console.WriteLine(flag("nonempty")?"1":"0");return 0;
  }
  if(name=="pg_dump") {
   int index=Array.IndexOf(args,"--file");File.WriteAllText(args[index+1],flag("empty")?"":"PGDMP-synthetic-archive");
   if(flag("slow"))Thread.Sleep(1500);
   if(flag("fail")){Console.Error.WriteLine("SENTINEL-provider-password");return 1;}return 0;
  }
  if(Array.IndexOf(args,"--list")>=0){Console.WriteLine("; Dumped from database version: 18.6\n; Dumped by pg_dump version: 18.6\n"+(flag("badlist")?"1; 1 1 TABLE other secret owner":"1; 2615 1 SCHEMA - public owner\n2; 1259 2 TABLE public settings owner\n3; 0 2 TABLE DATA public settings owner"));return 0;}
  if(flag("restorefail")){Console.Error.WriteLine("SENTINEL-provider-password");return 1;}
  File.WriteAllText(Path.Combine(root,"restored.txt"),String.Join("|",args));return 0;
 }
}
