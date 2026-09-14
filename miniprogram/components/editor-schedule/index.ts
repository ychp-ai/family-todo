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
  methods: componentMethods(["addTime", "another", "clearDate", "clearEndDate", "clearTime", "dateChange", "endDateChange", "removeTime", "repeatChange", "slotChange", "timeChange", "weekdaysChange"]),
});
