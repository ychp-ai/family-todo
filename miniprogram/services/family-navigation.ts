// switchTab 不支持查询参数；目标只在本次进程中传递，并由家庭页重新校验访问权。
let destination: string | null = null;

export function openFamilyTab(id = ""): void {
  destination = id;
  wx.switchTab({
    url: "/pages/families/index",
    fail: () => {
      destination = null;
      wx.showToast({ title: "暂时无法打开家庭，请重试", icon: "none" });
    },
  });
}

export function consumeFamilyDestination(): string | null {
  const id = destination;
  destination = null;
  return id;
}
