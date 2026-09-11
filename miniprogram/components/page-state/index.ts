Component({
  properties: {
    state: { type: String, value: "empty" },
    title: { type: String, value: "" },
    emptyText: { type: String, value: "暂无内容" },
    errorText: { type: String, value: "加载失败，请稍后重试" },
  },
  methods: {
    handleRetry() {
      this.triggerEvent("retry");
    },
  },
});
