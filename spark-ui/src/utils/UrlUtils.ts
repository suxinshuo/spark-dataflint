export const isHistoryServer = (): boolean =>
  window.location.href.includes("history");

export const isProxyMode = (): boolean =>
  !(
    window.location.pathname === "/dataflint" ||
    window.location.pathname === "/dataflint/"
  );

export const isDataFlintSaaSUI = (): boolean =>
  window.location.href.includes("dataflint-spark-ui");

export function hrefWithoutEndSlash(): string {
  const href = window.location.href;
  let fixedUrl = href.split("/#/")[0];

  // We are using a HashRouter so we split by #
  if (fixedUrl.endsWith("index.html")) {
    fixedUrl = fixedUrl.substring(0, fixedUrl.length - "index.html".length);
  }
  if (fixedUrl.includes("?o=")) {
    fixedUrl = fixedUrl.split("dataflint")[0] + "dataflint";
  }
  if (fixedUrl.endsWith("/")) {
    fixedUrl = fixedUrl.substring(0, fixedUrl.length - 1);
  }
  return fixedUrl;
}

export const getProxyBasePath = (): string => {
  const url = new URL(window.location.href);
  if (url.pathname.includes("history")) {
    const pathToRemove = /\/history\/[^/]+\/dataflint\/?$/;
    return url.origin + url.pathname.replace(pathToRemove, '');
  }
  return hrefWithoutEndSlash().substring(
      0,
      hrefWithoutEndSlash().lastIndexOf("/dataflint"),
  );
};

export function getHistoryServerCurrentAppId(): string {
  const urlSegments = hrefWithoutEndSlash().split("/");
  try {
    const historyIndex = urlSegments.findIndex(
      (segment) => segment === "history",
    );
    const appId = urlSegments[historyIndex + 1];
    return appId;
  } catch {
    throw new Error("Invalid history server app id");
  }
}

export const getBaseAppUrl = (appPath: string): string => {
  return appPath.substring(0, hrefWithoutEndSlash().lastIndexOf("/dataflint"));
};
