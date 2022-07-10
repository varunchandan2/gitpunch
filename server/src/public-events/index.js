import { loadAccessTokens } from "gitpunch-lib/db";
import fetch from "node-fetch";
import { SQS } from "aws-sdk";
// how often to fetch events in seconds
const INTERVAL = process.env.WAB_EVENTS_MONITORING_INTERVAL || 1;

const PER_PAGE = 100;
const PAGES = 3;
// how often github resets rate limit in seconds
const CYCLE = process.env.WAB_EVENTS_MONITORING_CYCLE || 3600;
const SQS_QUEUE_URL = process.env.WAB_SQS_QUEUE_URL;
const TRACK_EVENTS_FOR_DUPLICATES =
  +process.env.WAB_TRACK_EVENTS_FOR_DUPLICATES || 200;

let prevEvents = [];
export async function monitor() {
  const fetchStartTime = now();
  try {
    const accessToken = await pickAccessToken();
    const events = await fetchEvents(accessToken);
    const releaseEvents = events
      // keep only release/tag events
      .filter(
        (e) =>
          e.type === "ReleaseEvent" ||
          (e.type === "CreateEvent" && e.payload.ref_type === "tag")
      )
      // filter out duplicates
      .filter((e) => prevEvents.every((prevE) => prevE.id !== e.id));
    releaseEvents.forEach(sendMessageToQueue);
    prevEvents = prevEvents.concat(releaseEvents);
    if (prevEvents.length > TRACK_EVENTS_FOR_DUPLICATES) {
      prevEvents = prevEvents.slice(
        prevEvents.length - TRACK_EVENTS_FOR_DUPLICATES
      );
    }
  } catch (e) {
    console.log("Error" + e.message, e.stack);
  }
  setTimeout(monitor, timeUntilNextFetch(fetchStartTime));
}

const paginatedApiUrls = (() => {
  const baseUrl = "https://api.github.com/events";
  return Array.from(Array(PAGES)).map(
    (_, i) => `${baseUrl}?per_page=${PER_PAGE}&page=${i + 1}`
  );
})();
async function fetchEvents(accessToken) {
  const pages = await Promise.all(
    paginatedApiUrls.map(async (url) => {
      try {
        const response = await fetch(url, {
          headers: { Authorization: `token ${accessToken}` },
          timeout: 5000,
        });
        if (response.status !== 200) {
          throw new Error(`GitHub says ${response.status}`);
        }
        const events = await response.json();
        if (eventsValid(events)) {
          return events;
        }
        throw new Error("GitHub sends gibberish");
      } catch (e) {
        console.error("Fetch Error: " + e.message, e.stack);
        return [];
      }
    })
  );
  return pages
    .reduce((r, p) => [...r, ...p], [])
    .sort((e1, e2) => e2.id - e1.id)
    .filter((e, i, self) => self.find((_e) => _e.id === e.id) === e);
}

async function pickAccessToken() {
  const accessTokens = await loadAccessTokens();
  const nowInSeconds = Math.floor(now() / 1000);
  const cycleSecondIndex = nowInSeconds % (CYCLE / INTERVAL);
  const turn = cycleSecondIndex % accessTokens.length;
  return accessTokens[turn];
}

const sqs = new SQS({
  apiVersion: "2012-11-05",
  region: process.env.WAB_SQS_REGION,
});
function sendMessageToQueue({ id, type, repo, payload, created_at }) {
  const tagName =
    type === "ReleaseEvent" ? payload.release.tag_name : payload.ref;
  const message = {
    id,
    type,
    repoName: repo.name,
    tagName,
    createdAt: created_at,
  };
  sqs.sendMessage(
    {
      MessageBody: JSON.stringify(message),
      QueueUrl: SQS_QUEUE_URL,
    },
    (err, data) =>
      err && console.error("Can't send message to queue", message, err)
  );
}

function timeUntilNextFetch(fetchStartTime) {
  const nextOnSchedule = fetchStartTime + INTERVAL * 1000;
  const nowTs = now();
  if (nowTs > nextOnSchedule) {
    return 0;
  }
  return nextOnSchedule - nowTs;
}

function now() {
  return new Date().getTime();
}

function eventsValid(events) {
  return (
    Array.isArray(events) && events.every((e) => e && e.id && !isNaN(e.id))
  );
}
