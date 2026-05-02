import { redirect } from 'next/navigation';

export default function NewChallengeRedirect() {
  redirect('/challenges');
}
