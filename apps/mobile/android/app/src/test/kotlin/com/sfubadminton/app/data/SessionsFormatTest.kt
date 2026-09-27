package com.sfubadminton.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsFormatTest {
    @Test
    fun `formats a Postgres date without a zone`() {
        assertEquals("Sun 4 Oct", formatSessionDate("2026-10-04"))
        assertEquals("Sun 4 Oct", formatSessionDate("2026-10-04T00:00:00"))
    }

    @Test
    fun `leaves a malformed date unchanged`() {
        assertEquals("soon", formatSessionDate("soon"))
    }

    @Test
    fun `writes a time range, a start alone, or nothing`() {
        assertEquals("18:00 to 20:30", timeRange("18:00:00", "20:30:00"))
        assertEquals("18:00", timeRange("18:00:00", null))
        assertEquals("", timeRange(null, null))
    }

    @Test
    fun `builds the web's schedule query`() {
        assertEquals(
            "/rest/v1/sessions?select=id%2Cname%2Cdate%2Cstart_time%2Cend_time%2Clocation%2Ctrack" +
                "&status=eq.open&track=in.%28competitive%2Call%29&date=gte.2026-10-04" +
                "&or=%28season_id.eq.s1%2Cseason_id.is.null%29&order=date.asc%2Cstart_time.asc.nullslast",
            upcomingSessionsQuery("competitive", "2026-10-04", "s1").pathAndQuery(),
        )
    }

    @Test
    fun `leaves the season filter off with no active season`() {
        assertEquals(
            "/rest/v1/sessions?select=id%2Cname%2Cdate%2Cstart_time%2Cend_time%2Clocation%2Ctrack" +
                "&status=eq.open&track=in.%28competitive%2Crecreational%2Call%29&date=gte.2026-10-04" +
                "&order=date.asc%2Cstart_time.asc.nullslast",
            upcomingSessionsQuery("pending_approval", "2026-10-04", null).pathAndQuery(),
        )
    }
}
