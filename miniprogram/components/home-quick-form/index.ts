import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    quickFamilyIndex: { type: Number, value: 0 },
    quickFamilyOptions: { type: Array, value: [] },
    quickSubjectNames: { type: Array, value: [] },
    quickSubjectIndex: { type: Number, value: 0 },
    quickRows: { type: Array, value: [] },
    quickNotice: { type: String, value: "" },
    quickLoading: { type: Boolean, value: false },
    quickTitle: { type: String, value: "" },
    quickDate: { type: String, value: "" },
    quickTime: { type: String, value: "" },
    quickRepeatIndex: { type: Number, value: 0 },
    quickRepeatOptions: { type: Array, value: [] },
    quickNote: { type: String, value: "" },
    quickReminder: { type: Boolean, value: false },
    expanded: { type: Boolean, value: false },
    quickError: { type: String, value: "" },
    quickSuccess: { type: String, value: "" },
    saving: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false },
    writing: { type: Boolean, value: false }
  },
  methods: componentMethods(["expand", "fullEditor", "quickDateChange", "quickFamilyChange", "quickNoteInput", "quickReminderChange", "quickRepeatChange", "quickSubjectChange", "quickTimeChange", "quickTitleInput", "quickViewersChange", "retryQuickFamily", "saveQuick"]),
});
