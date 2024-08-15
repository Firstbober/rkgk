import { Wall } from "./wall.js";
import { getUserId, newSession, waitForLogin } from "./session.js";
import { debounce } from "./framework.js";
import { ReticleCursor } from "./reticle-renderer.js";

const updateInterval = 1000 / 60;

let main = document.querySelector("main");
let canvasRenderer = main.querySelector("rkgk-canvas-renderer");
let reticleRenderer = main.querySelector("rkgk-reticle-renderer");
let brushEditor = main.querySelector("rkgk-brush-editor");

reticleRenderer.connectViewport(canvasRenderer.viewport);

// In the background, connect to the server.
(async () => {
    await waitForLogin();
    console.info("login ready! starting session");

    let session = await newSession(getUserId(), localStorage.getItem("rkgk.mostRecentWallId"), {
        brush: brushEditor.code,
    });
    localStorage.setItem("rkgk.mostRecentWallId", session.wallId);

    let wall = new Wall(session.wallInfo);
    canvasRenderer.initialize(wall);

    for (let onlineUser of session.wallInfo.online) {
        wall.onlineUsers.addUser(onlineUser.sessionId, {
            nickname: onlineUser.nickname,
            brush: onlineUser.init.brush,
        });
    }

    let currentUser = wall.onlineUsers.getUser(session.sessionId);

    session.addEventListener("error", (event) => console.error(event));

    session.addEventListener("wallEvent", (event) => {
        let wallEvent = event.wallEvent;
        if (wallEvent.sessionId != session.sessionId) {
            if (wallEvent.kind.event == "join") {
                wall.onlineUsers.addUser(wallEvent.sessionId, {
                    nickname: wallEvent.kind.nickname,
                    brush: wallEvent.kind.init.brush,
                });
            }

            let user = wall.onlineUsers.getUser(wallEvent.sessionId);
            if (user == null) {
                console.warn("received event for an unknown user", wallEvent);
                return;
            }

            if (wallEvent.kind.event == "leave") {
                if (user.reticle != null) {
                    reticleRenderer.removeReticle(user.reticle);
                }
                wall.onlineUsers.removeUser(wallEvent.sessionId);
            }

            if (wallEvent.kind.event == "cursor") {
                if (user.reticle == null) {
                    user.reticle = new ReticleCursor(
                        wall.onlineUsers.getUser(wallEvent.sessionId).nickname,
                    );
                    reticleRenderer.addReticle(user.reticle);
                }

                let { x, y } = wallEvent.kind.position;
                user.reticle.setCursor(x, y);
            }

            if (wallEvent.kind.event == "setBrush") {
                user.setBrush(wallEvent.kind.brush);
            }

            if (wallEvent.kind.event == "plot") {
                for (let { x, y } of wallEvent.kind.points) {
                    user.renderBrushToChunks(wall, x, y);
                }
            }
        }
    });

    let pendingChunks = 0;
    let chunkDownloadStates = new Map();

    function sendViewportUpdate() {
        let visibleRect = canvasRenderer.getVisibleChunkRect();
        session.sendViewport(visibleRect);

        for (let chunkY = visibleRect.top; chunkY < visibleRect.bottom; ++chunkY) {
            for (let chunkX = visibleRect.left; chunkX < visibleRect.right; ++chunkX) {
                let key = Wall.chunkKey(chunkX, chunkY);
                let currentState = chunkDownloadStates.get(key);
                if (currentState == null) {
                    chunkDownloadStates.set(key, "requested");
                    pendingChunks += 1;
                }
            }
        }
        console.info("pending chunks after viewport update", pendingChunks);
    }

    canvasRenderer.addEventListener(".viewportUpdate", sendViewportUpdate);
    sendViewportUpdate();

    session.addEventListener("chunks", (event) => {
        let { chunkInfo, chunkData } = event;

        console.info("received data for chunks", {
            chunkInfoLength: chunkInfo.length,
            chunkDataSize: chunkData.size,
        });

        for (let info of event.chunkInfo) {
            let key = Wall.chunkKey(info.position.x, info.position.y);
            if (chunkDownloadStates.get(key) == "requested") {
                pendingChunks -= 1;
            }
            chunkDownloadStates.set(key, "downloaded");

            if (info.length > 0) {
                let blob = chunkData.slice(info.offset, info.offset + info.length, "image/webp");
                createImageBitmap(blob).then((bitmap) => {
                    let chunk = wall.getOrCreateChunk(info.position.x, info.position.y);
                    chunk.ctx.globalCompositeOperation = "copy";
                    chunk.ctx.drawImage(bitmap, 0, 0);
                    chunk.syncToPixmap();
                });
            }
        }
    });

    let reportCursor = debounce(updateInterval, (x, y) => session.sendCursor(x, y));
    canvasRenderer.addEventListener(".cursor", async (event) => {
        reportCursor(event.x, event.y);
    });

    let plotQueue = [];
    async function flushPlotQueue() {
        let points = plotQueue.splice(0, plotQueue.length);
        if (points.length != 0) {
            session.sendPlot(points);
        }
    }

    setInterval(flushPlotQueue, updateInterval);

    canvasRenderer.addEventListener(".paint", async (event) => {
        plotQueue.push({ x: event.x, y: event.y });
        currentUser.renderBrushToChunks(wall, event.x, event.y);
    });

    canvasRenderer.addEventListener(".viewportUpdate", () => reticleRenderer.render());

    currentUser.setBrush(brushEditor.code);
    brushEditor.addEventListener(".codeChanged", async () => {
        flushPlotQueue();
        currentUser.setBrush(brushEditor.code);
        session.sendSetBrush(brushEditor.code);
    });

    session.eventLoop();
})();
