/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fetch, { RequestInit, Response } from 'node-fetch';
import { Config } from '@backstage/config';
import { NotFoundError } from '../errors';
import { UrlReader } from './types';
import { ReaderFactory } from './UrlReaders';

type Options = {
  // TODO: added here for future support, but we only allow bitbucket.org for now
  host: string;
  token?: string;
};

export function readConfig(config: Config): Options[] {
  const optionsArr = Array<Options>();

  const providerConfigs =
    config.getOptionalConfigArray('integrations.gitlab') ?? [];

  for (const providerConfig of providerConfigs) {
    const host = providerConfig.getOptionalString('host') ?? 'gitlab.com';
    const token = providerConfig.getOptionalString('token');

    optionsArr.push({ host, token });
  }

  // As a convenience we always make sure there's at least an unauthenticated
  // reader for public gitlab repos.
  if (!optionsArr.some(p => p.host === 'gitlab.com')) {
    optionsArr.push({ host: 'gitlab.com' });
  }

  return optionsArr;
}

export class GitlabUrlReader implements UrlReader {
  static factory: ReaderFactory = ({ config }) => {
    return readConfig(config).map(options => {
      const reader = new GitlabUrlReader(options);
      const predicate = (url: URL) => url.host === options.host;
      return { reader, predicate };
    });
  };

  constructor(private readonly options: Options) {}

  getRequestOptions(): RequestInit {
    return {
      headers: {
        ['PRIVATE-TOKEN']: this.options.token ?? '',
      },
    };
  }

  async read(url: string): Promise<Buffer> {
    // TODO(Rugvip): merged the old GitlabReaderProcessor in here and used
    // the existence of /~/blob/ to switch the logic. Don't know if this
    // makes sense and it might require some more work.
    let builtUrl: URL;
    if (url.includes('/-/blob/')) {
      const projectID = await this.getProjectID(url);
      builtUrl = this.buildProjectUrl(url, projectID);
    } else {
      builtUrl = this.buildRawUrl(url);
    }

    let response: Response;
    try {
      response = await fetch(builtUrl.toString(), this.getRequestOptions());
    } catch (e) {
      throw new Error(`Unable to read ${url}, ${e}`);
    }

    if (response.ok) {
      return response.buffer();
    }

    const message = `${url} could not be read as ${builtUrl}, ${response.status} ${response.statusText}`;
    if (response.status === 404) {
      throw new NotFoundError(message);
    }
    throw new Error(message);
  }

  // Converts
  // from: https://gitlab.example.com/a/b/blob/master/c.yaml
  // to:   https://gitlab.example.com/a/b/raw/master/c.yaml
  buildRawUrl(target: string): URL {
    try {
      const url = new URL(target);

      const [empty, userOrOrg, repoName, ...restOfPath] = url.pathname
        .split('/')
        // for the common case https://gitlab.example.com/a/b/-/blob/master/c.yaml
        .filter(path => path !== '-');

      if (
        empty !== '' ||
        userOrOrg === '' ||
        repoName === '' ||
        !restOfPath.join('/').match(/\.yaml$/)
      ) {
        throw new Error('Wrong GitLab URL');
      }

      // Replace 'blob' with 'raw'
      url.pathname = [empty, userOrOrg, repoName, 'raw', ...restOfPath].join(
        '/',
      );

      return url;
    } catch (e) {
      throw new Error(`Incorrect url: ${target}, ${e}`);
    }
  }

  // convert https://gitlab.com/groupA/teams/teamA/subgroupA/repoA/-/blob/branch/filepath
  // to https://gitlab.com/api/v4/projects/<PROJECTID>/repository/files/filepath?ref=branch
  buildProjectUrl(target: string, projectID: Number): URL {
    try {
      const url = new URL(target);

      const branchAndfilePath = url.pathname.split('/-/blob/')[1];

      const [branch, ...filePath] = branchAndfilePath.split('/');

      url.pathname = [
        '/api/v4/projects',
        projectID,
        'repository/files',
        encodeURIComponent(filePath.join('/')),
        'raw',
      ].join('/');
      url.search = `?ref=${branch}`;

      return url;
    } catch (e) {
      throw new Error(`Incorrect url: ${target}, ${e}`);
    }
  }

  async getProjectID(target: string): Promise<Number> {
    const url = new URL(target);

    if (
      // absPaths to gitlab files should contain /-/blob
      // ex: https://gitlab.com/groupA/teams/teamA/subgroupA/repoA/-/blob/branch/filepath
      !url.pathname.match(/\/\-\/blob\//)
    ) {
      throw new Error('Please provide full path to yaml file from Gitlab');
    }
    try {
      const repo = url.pathname.split('/-/blob/')[0];

      // Find ProjectID from url
      // convert 'https://gitlab.com/groupA/teams/teamA/subgroupA/repoA/-/blob/branch/filepath'
      // to 'https://gitlab.com/api/v4/projects/groupA%2Fteams%2FsubgroupA%2FteamA%2Frepo'
      const repoIDLookup = new URL(
        `${url.protocol + url.hostname}/api/v4/projects/${encodeURIComponent(
          repo.replace(/^\//, ''),
        )}`,
      );
      const response = await fetch(
        repoIDLookup.toString(),
        this.getRequestOptions(),
      );
      const projectIDJson = await response.json();
      const projectID: Number = projectIDJson.id;

      return projectID;
    } catch (e) {
      throw new Error(`Could not get GitLab ProjectID for: ${target}, ${e}`);
    }
  }

  toString() {
    const { host, token } = this.options;
    return `gitlab{host=${host},authed=${Boolean(token)}}`;
  }
}
