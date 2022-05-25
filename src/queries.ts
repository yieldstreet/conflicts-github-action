import axios from 'axios'
import * as core from '@actions/core'
import {Context} from '@actions/github/lib/context'
import {GitHub} from '@actions/github/lib/utils'
import {
  IGitHubPRNode,
  IGitHubRepoLabels,
  IGitHubRepoPullRequests,
  IGitHubFileChange,
  IGitHubRepoPullRequest,
  IGitHubPullRequest
} from './interfaces'

const getPullRequestPages = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  cursor?: string
): Promise<IGitHubRepoPullRequests> => {
  const query = `query ($owner: String!, $repo: String!, $after: String) {
    repository(owner:$owner name:$repo) {
      pullRequests(first: 100, states: OPEN, after: $after) {
        edges {
          node {
            id
            number
            author {
              login
            }
            mergeable
            potentialMergeCommit {
              oid 
            }
            labels(first: 100) {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }`

  return octokit.graphql(query, {
    ...context.repo,
    after: cursor
  })
}

// fetch all PRs
export const getPullRequests = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context
): Promise<IGitHubPRNode[]> => {
  let pullrequests: IGitHubPRNode[] = []
  let cursor: string | undefined
  let hasNextPage = false

  do {
    const pullrequestData = await getPullRequestPages(octokit, context, cursor)

    pullrequests = pullrequests.concat(pullrequestData.repository.pullRequests.edges)
    cursor = pullrequestData.repository.pullRequests.pageInfo.endCursor
    hasNextPage = pullrequestData.repository.pullRequests.pageInfo.hasNextPage
  } while (hasNextPage)

  return pullrequests
}

export const getPullRequest = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  number: number
): Promise<IGitHubPullRequest> => {
  const query = `query ($owner: String!, $repo: String!, $number: Int!) { 
    repository(owner: $owner name: $repo) {
      pullRequest(number: $number) {
        id
        number
        author {
          login
        }
        mergeable
        potentialMergeCommit {
          oid
        }
        labels(first: 100) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  }`

  const repoPr: IGitHubRepoPullRequest = await octokit.graphql(query, {
    ...context.repo,
    number
  })

  return repoPr.repository.pullRequest
}

export const getLabels = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  labelName: string
): Promise<IGitHubRepoLabels> => {
  const query = `query ($owner: String!, $repo: String!, $labelName: String!) { 
    repository(owner: $owner name: $repo) {
      labels(first: 10, query: $labelName) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }`

  return octokit.graphql(query, {
    ...context.repo,
    labelName
  })
}

export const addLabelToLabelable = async (
  octokit: InstanceType<typeof GitHub>,
  {
    labelId,
    labelableId
  }: {
    labelId: string
    labelableId: string
  },
  pullRequestNumber: number,
  pullRequestAuthor: string,
  context: Context
) => {
  const slackWebhookUrl = core.getInput('slack_webhook_url', {required: true})
  const slackWebhookChannel = core.getInput('slack_webhook_channel', {required: true})
  const {owner, repo} = context.repo
  const slackMessage =
    pullRequestAuthor === 'githubys'
      ? `There's a *backmerge* conflict on <https://github.com/${owner}/${repo}/pull/${pullRequestNumber}|This Pull Request> (${repo}). Please fix it before it lands on the release mgmt process.`
      : `There's a conflict on <https://github.com/${owner}/${repo}/pull/${pullRequestNumber}|This Pull Request> (${repo}). If you are the author (@${pullRequestAuthor}), please fix it.`
  const pullMessage =
    pullRequestAuthor === 'githubys'
      ? `:warning: There is a backmerge conflict on this PR. Please fix it before it lands on the release mgmt process.`
      : `:warning: There is a conflict on this PR. @${pullRequestAuthor} as you are the author, please fix it.`

  const query = `mutation ($label, $pullRequest) {
    addLabelsToLabelable(input: {labelIds: [$label], labelableId: $pullRequest}) {
      clientMutationId
    }
  }`
  const addComment = `mutation comment($id: ID!, $body: String!) {
      addComment(input: {subjectId: $id, body: $body}) {
        clientMutationId
      }
    }
  `

  await axios.post(slackWebhookUrl, {
    channel: '#test-channel',
    text: slackMessage,
    username: 'PR Conflicts Bot',
    // eslint-disable-next-line camelcase
    icon_emoji: ':warning:'
  })

  await octokit.graphql(query, {label: labelId, pullRequest: labelableId})

  return octokit.graphql(addComment, {
    id: labelableId,
    body: pullMessage
  })
}

export const removeLabelFromLabelable = async (
  octokit: InstanceType<typeof GitHub>,
  {
    labelId,
    labelableId
  }: {
    labelId: string
    labelableId: string
  }
) => {
  const query = `mutation ($label: String!, $pullRequest: String!) {
    removeLabelsFromLabelable(input: {labelIds: [$label], labelableId: $pullRequest}) {
      clientMutationId
    }
  }`

  return octokit.graphql(query, {label: labelId, pullRequest: labelableId})
}

export const getPullRequestChanges = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  pullRequestnumber: number
): Promise<IGitHubFileChange[]> => {
  const head = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: pullRequestnumber, // eslint-disable-line camelcase
    /**
     * This is correct the different default values which on larger pull requests is an issue.
     * There is no pagination support.
     *
     * https://docs.github.com/en/rest/reference/pulls#list-pull-requests-files
     * > Responses include a maximum of 3000 files. The paginated response returns 30 files per page by default.
     *
     * https://docs.github.com/en/rest/reference/repos#get-a-commit
     * > If there are more than 300 files in the commit diff, the response will include pagination link headers for the remaining files, up to a limit of 3000 files.
     */
    per_page: 300 // eslint-disable-line camelcase
  })

  return head.data
}

export const getCommitChanges = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  sha: string
): Promise<IGitHubFileChange[]> => {
  const mergeCommit = await octokit.rest.repos.getCommit({
    ...context.repo,
    ref: sha
  })

  if (typeof mergeCommit.data.files === 'undefined') {
    throw new Error(`merge commit with an unknown diff!`)
  }

  return mergeCommit.data.files as IGitHubFileChange[]
}
