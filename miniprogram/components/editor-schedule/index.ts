import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    repeat: { type: String, value: "" },
    endDate: { type: String, value: "" },
    times: { type: Array, value: [] },

    lockedSkipped: { type: Boolean, value: false },
    repeatOptions: { type: Array, value: [] },
    repeatIndex: { type: Number, value: 0 },
    weekdayRows: { type: Array, value: [] },
    id: { type: String, value: "" },
    date: { type: String, value: "" },
    time: { type: String, value: "" },
    saving: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false },
    scheduleLocked: { type: Boolean, value: false },
    shareOnly: { type: Boolean, value: false }
  },
  methods: {
    selectRepeat(event: WechatMiniprogram.TouchEvent) {
      if (this.data.scheduleLocked || this.data.shareOnly || this.data.saving || this.data.uncertain) return;
      this.triggerEvent("action", { handler: "repeatChange", detail: { value: event.currentTarget.dataset.index }, dataset: {} });
    },
    ...componentMethods(["addTime", "another", "clearDate", "clearEndDate", "clearTime", "dateChange", "endDateChange", "removeTime", "repeatChange", "slotChange", "timeChange", "weekdaysChange"]),
  },
});
