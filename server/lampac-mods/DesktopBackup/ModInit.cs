using Shared;
using Shared.Models.AppConf;
using Shared.Models.Events;
using Shared.Models.Module;
using Shared.Models.Module.Interfaces;

namespace DesktopBackup;

public class ModInit : IModuleLoaded
{
    public static string modpath;

    public void Loaded(InitspaceModel baseconf)
    {
        modpath = baseconf.path;

        CoreInit.conf.WAF.limit_map.Insert(0, new WafLimitRootMap(
            "^/database/desktop-backup/",
            new WafLimitMap { limit = 20, second = 1 }
        ));
    }

    public void Dispose() { }
}
