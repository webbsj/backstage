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

import { BitbucketApiReaderProcessor } from './BitbucketApiReaderProcessor';
import { ConfigReader } from '@backstage/config';

describe('BitbucketApiReaderProcessor', () => {
  const createConfig = (
    username: string | undefined,
    appPassword: string | undefined,
  ) =>
    ConfigReader.fromConfigs([
      {
        context: '',
        data: {
          catalog: {
            processors: {
              bitbucketApi: {
                username: username,
                appPassword: appPassword,
              },
            },
          },
        },
      },
    ]);

  it('should build raw api', () => {
    const processor = new BitbucketApiReaderProcessor(
      createConfig(undefined, undefined),
    );

    const tests = [
      {
        target:
          'https://bitbucket.org/org-name/repo-name/src/master/templates/my-template.yaml',
        url: new URL(
          'https://api.bitbucket.org/2.0/repositories/org-name/repo-name/src/master/templates/my-template.yaml',
        ),
        err: undefined,
      },
      {
        target: 'https://api.com/a/b/blob/master/path/to/c.yaml',
        url: null,
        err:
          'Incorrect url: https://api.com/a/b/blob/master/path/to/c.yaml, Error: Wrong Bitbucket URL or Invalid file path',
      },
      {
        target: 'com/a/b/blob/master/path/to/c.yaml',
        url: null,
        err:
          'Incorrect url: com/a/b/blob/master/path/to/c.yaml, TypeError: Invalid URL: com/a/b/blob/master/path/to/c.yaml',
      },
    ];

    for (const test of tests) {
      if (test.err) {
        expect(() => processor.buildRawUrl(test.target)).toThrowError(test.err);
      } else if (test.url) {
        expect(processor.buildRawUrl(test.target).toString()).toEqual(
          test.url.toString(),
        );
      } else {
        throw new Error(
          'This should not have happened. Either err or url should have matched.',
        );
      }
    }
  });

  it('should return request options', () => {
    const tests = [
      {
        username: '',
        password: '',
        expect: {
          headers: {},
        },
        err:
          "Invalid type in config for key 'catalog.processors.bitbucketApi.username' in '', got empty-string, wanted string",
      },
      {
        username: 'only-user-provided',
        password: '',
        expect: {
          headers: {},
        },
        err:
          "Invalid type in config for key 'catalog.processors.bitbucketApi.appPassword' in '', got empty-string, wanted string",
      },
      {
        username: '',
        password: 'only-password-provided',
        expect: {
          headers: {},
        },
        err:
          "Invalid type in config for key 'catalog.processors.bitbucketApi.username' in '', got empty-string, wanted string",
      },
      {
        username: 'some-user',
        password: 'my-secret',
        expect: {
          headers: {
            Authorization: 'Basic c29tZS11c2VyOm15LXNlY3JldA==',
          },
        },
      },
      {
        username: undefined,
        password: undefined,
        expect: {
          headers: {},
        },
      },
      {
        username: 'only-user-provided',
        password: undefined,
        expect: {
          headers: {},
        },
      },
      {
        username: undefined,
        password: 'only-password-provided',
        expect: {
          headers: {},
        },
      },
    ];

    for (const test of tests) {
      if (test.err) {
        expect(
          () =>
            new BitbucketApiReaderProcessor(
              createConfig(test.username, test.password),
            ),
        ).toThrowError(test.err);
      } else {
        const processor = new BitbucketApiReaderProcessor(
          createConfig(test.username, test.password),
        );
        expect(processor.getRequestOptions()).toEqual(test.expect);
      }
    }
  });
});
