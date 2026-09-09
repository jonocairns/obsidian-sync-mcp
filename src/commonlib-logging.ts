import { setGlobalLogFunction, LEVEL_INFO } from "octagonal-wheels/common/logger";

/** Never emit Commonlib messages: they may contain private vault paths. */
export function configureCommonlibLogging(debug: boolean) {
    setGlobalLogFunction((_message, level = LEVEL_INFO) => {
        if (level < LEVEL_INFO) return;
        if (debug) console.log("[livesync] internal event (details redacted)");
    });
}
